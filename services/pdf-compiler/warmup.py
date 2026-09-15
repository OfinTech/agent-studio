"""Build-time dependency set; no downloads are allowed when serving jobs."""
from pathlib import Path
import subprocess
source = Path("/opt/warmup.tex").read_text()
for cls in ("report", "article"):
    for size in (10, 11, 12):
        text = source.replace(r"\documentclass{report}", rf"\documentclass[{size}pt]{{{cls}}}")
        if cls == "article":
            text = text.replace(r"\chapter", r"\section")
        Path("/opt/check.tex").write_text(text)
        subprocess.run(["tectonic", "-X", "compile", "--untrusted", "check.tex"], cwd="/opt", check=True)
        subprocess.run(["tectonic", "-X", "compile", "--untrusted", "--only-cached", "check.tex"], cwd="/opt", check=True)
for path in Path("/opt").glob("check.*"):
    path.unlink()
