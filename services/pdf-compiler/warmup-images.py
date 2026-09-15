"""Warm and verify graphicx with real PNG/JPEG images in the new profile only."""
from pathlib import Path
import subprocess
from PIL import Image

for extension in ("png", "jpg"):
    Image.new("RGB", (40, 20), (20, 100, 180)).save("/opt/logo." + extension)
for cls in ("article", "report"):
    Path("/opt/images.tex").write_text(r"\documentclass{" + cls + r"}\usepackage{graphicx}\begin{document}Synthetic logo test.\includegraphics[width=1cm]{logo.png}\includegraphics[width=1cm]{logo.jpg}\end{document}")
    for offline in (False, True):
        subprocess.run(["tectonic", "-X", "compile", "--untrusted", *(["--only-cached"] if offline else []), "images.tex"], cwd="/opt", check=True)
for pattern in ("images.*", "logo.*"):
    for path in Path("/opt").glob(pattern):
        path.unlink()
