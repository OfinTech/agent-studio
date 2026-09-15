"""Credential-free, single-job offline LaTeX renderer. Run only with Compose isolation."""
import base64
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
MAX_PDF = 10 * 1024 * 1024
JOBS = Path("/tmp/jobs")
LOCK = threading.Lock()


def compile_report(source, connection=None):
    if not isinstance(source, str) or not source.strip() or len(source.encode()) > 131072:
        return {"ok": False, "error": "Provide nonempty LaTeX source, at most 128 KiB."}
    deadline = time.monotonic() + 30
    with tempfile.TemporaryDirectory(dir=JOBS) as directory:
        work = Path(directory)
        (work / "report.tex").write_text(source)

        def command(args, logname):
            with (work / logname).open("wb") as log:
                process = subprocess.Popen(["python3", "-B", "/opt/runner.py", *args], cwd=work, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True,
                                           env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": directory,
                                                "XDG_CACHE_HOME": "/opt/tex-cache", "TECTONIC_UNTRUSTED_MODE": "1",
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
            return {"ok": True, "profile": PROFILE, "pdf": base64.b64encode(pdf.read_bytes()).decode(),
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
        self.reply(200 if self.path == "/health" else 404, {"profile": PROFILE})

    def do_POST(self):
        if self.path != "/compile":
            return self.reply(404, {"ok": False})
        if not LOCK.acquire(blocking=False):
            return self.reply(503, {"ok": False, "error": "Compiler busy"})
        try:
            self.connection.settimeout(5)
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 800000:
                return self.reply(413, {"ok": False, "error": "Request too large"})
            data = json.loads(self.rfile.read(length))
            if data.get("profile") != PROFILE:
                return self.reply(400, {"ok": False, "error": "Unsupported renderer profile"})
            self.reply(200, compile_report(data.get("source"), self.connection))
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
