"""Warm diagram/report dependencies into v3 only, then verify offline compilation."""
from pathlib import Path
import subprocess

source = Path("/opt/warmup-diagrams.tex").read_text()
for cls in ("article", "report"):
    for size in (10, 11, 12):
        text = source.replace(r"\documentclass[11pt]{article}", rf"\documentclass[{size}pt]{{{cls}}}")
        Path("/opt/diagrams.tex").write_text(text)
        for offline in (False, True):
            subprocess.run(["tectonic", "-X", "compile", "--untrusted", *(["--only-cached"] if offline else []), "diagrams.tex"], cwd="/opt", check=True)
for path in Path("/opt").glob("diagrams.*"):
    path.unlink()
