"""Credential-free, single-job offline LaTeX renderer. Run only with Compose isolation."""
import base64
import hashlib
import io
import re
from PIL import Image
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILE = "tectonic-0.15.0-bundle33-report-v1"
TEMPLATE_PROFILE = "tectonic-0.15.0-bundle33-template-v2"
Image.MAX_IMAGE_PIXELS = 16000000
MAX_PDF = 10 * 1024 * 1024
JOBS = Path("/tmp/jobs")
LOCK = threading.Lock()


def validate_resources(resources, profile):
    if not isinstance(resources, list) or len(resources) > 10 or (profile == PROFILE and resources):
        raise ValueError("Invalid image resources or renderer profile")
    decoded, names, total = [], set(), 0
    for item in resources:
        name = item.get("filename", "")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.(png|jpg)", name) or name in names:
            raise ValueError("Invalid or duplicate image filename")
        names.add(name)
        content = item.get("content", "")
        if not isinstance(content, str) or len(content) > 6990508:
            raise ValueError("Image exceeds 5 MiB")
        raw = base64.b64decode(content, validate=True)
        total += len(raw)
        if not 0 < len(raw) <= 5242880 or total > 20971520 or item.get("size") != len(raw):
            raise ValueError("Image resources exceed size limits")
        if hashlib.sha256(raw).hexdigest() != item.get("checksum"):
            raise ValueError("Image checksum does not match")
        expected = "PNG" if name.endswith(".png") else "JPEG"
        if item.get("mimeType") != ("image/png" if expected == "PNG" else "image/jpeg"):
            raise ValueError("Invalid image media type")
        with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG"]) as image:
            if image.format != expected or getattr(image, "n_frames", 1) != 1 or image.width * image.height > 16000000:
                raise ValueError("Invalid image content or dimensions")
            image.verify()
        with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG"]) as image:
            image.load()
        decoded.append((name, raw))
    return decoded


def compile_report(source, connection=None, profile=PROFILE, resources=None):
    if not isinstance(source, str) or not source.strip() or len(source.encode()) > 131072:
        return {"ok": False, "error": "Provide nonempty LaTeX source, at most 128 KiB."}
    try:
        images = validate_resources(resources or [], profile)
    except (ValueError, OSError, TypeError, AttributeError, Image.DecompressionBombError):
        return {"ok": False, "error": "Invalid image resources: check filenames, checksums, image content and limits."}
    deadline = time.monotonic() + 30
    with tempfile.TemporaryDirectory(dir=JOBS) as directory:
        work = Path(directory)
        (work / "report.tex").write_text(source)
        if images:
            (work / "assets").mkdir(mode=0o700)
            for name, raw in images:
                (work / "assets" / name).write_bytes(raw)

        def command(args, logname):
            with (work / logname).open("wb") as log:
                process = subprocess.Popen(["python3", "-B", "/opt/runner.py", *args], cwd=work, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True,
                                           env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": directory,
                                                "XDG_CACHE_HOME": "/opt/tex-cache-template" if profile == TEMPLATE_PROFILE else "/opt/tex-cache", "TECTONIC_UNTRUSTED_MODE": "1",
                                                "SOURCE_DATE_EPOCH": "1788825600"})
                try:
                    while process.poll() is None:
                        if time.monotonic() >= deadline:
                            raise ValueError("Compilation and validation exceeded 30 seconds. Simplify the report.")
                        if connection and select.select([connection], [], [], 0)[0]:
                            if connection.recv(1, socket.MSG_PEEK) == b"":
                                raise ValueError("Compilation cancelled.")
                        time.sleep(0.025)
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
            # Never load unbounded compiler chatter into memory or return local paths.
            with (work / logname).open("rb") as log:
                log.seek(max(0, (work / logname).stat().st_size - 8000))
                output = log.read(8000).decode(errors="replace").replace(directory, "[job]")
            if process.returncode:
                raise ValueError("LaTeX or PDF validation failed. Correct the source: " + output[-4000:])
            return output

        try:
            log = command(["tectonic", "-X", "compile", "--untrusted", "--only-cached", "--print", "report.tex"], "compiler.log")
            pdf = work / "report.pdf"
            if not pdf.exists() or not 0 < pdf.stat().st_size <= MAX_PDF:
                raise ValueError("Report must produce a PDF of at most 10 MiB.")
            info = command(["pdfinfo", "report.pdf"], "info.log")
            fields = dict(line.split(":", 1) for line in info.splitlines() if ":" in line)
            pages = int(fields.get("Pages", "0").strip())
            if not fields.get("Encrypted", "").strip().startswith("no") or not 1 <= pages <= 20:
                raise ValueError("Report must be unencrypted and contain 1 to 20 pages.")
            command(["pdftotext", "-enc", "UTF-8", "report.pdf", "text.txt"], "extract.log")
            with (work / "text.txt").open() as textfile:
                extracted = textfile.read(20001).strip()
            if not extracted:
                raise ValueError("Report has no extractable text. Include text in the document.")
            warnings = [line[:500] for line in log.splitlines()
                        if any(word in line.lower() for word in ("warning", "overfull", "underfull"))][:10]
            return {"ok": True, "profile": profile, "pdf": base64.b64encode(pdf.read_bytes()).decode(),
                    "pageCount": pages, "warnings": warnings, "text": extracted[:20000],
                    "textTruncated": len(extracted) > 20000}
        except (ValueError, OSError) as error:
            return {"ok": False, "error": str(error)[:4000]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, status, data):
        encoded = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"profile": PROFILE, "profiles": [PROFILE, TEMPLATE_PROFILE]})

    def do_POST(self):
        if self.path != "/compile":
            return self.reply(404, {"ok": False})
        if not LOCK.acquire(blocking=False):
            return self.reply(503, {"ok": False, "error": "Compiler busy"})
        try:
            self.connection.settimeout(5)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 29000000:
                return self.reply(413, {"ok": False, "error": "Request too large"})
            data = json.loads(self.rfile.read(length))
            if data.get("profile") not in (PROFILE, TEMPLATE_PROFILE):
                return self.reply(400, {"ok": False, "error": "Unsupported renderer profile"})
            self.reply(200, compile_report(data.get("source"), self.connection, data["profile"], data.get("resources", [])))
        except (ValueError, OSError):
            try:
                self.reply(400, {"ok": False, "error": "Invalid or cancelled request"})
            except OSError:
                pass
        finally:
            LOCK.release()


if __name__ == "__main__":
    # The job directory contains no durable data. Clear interrupted jobs before listening.
    shutil.rmtree(JOBS, ignore_errors=True)
    JOBS.mkdir(mode=0o700, parents=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
