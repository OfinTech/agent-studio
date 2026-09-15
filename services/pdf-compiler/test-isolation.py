"""Executed inside the hardened compiler container by test:pdf:isolation."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
assert os.getuid() == 10001
assert not Path("/data/attachments").exists()
assert not Path("/app").exists()
assert not any(key in os.environ for key in ("DATABASE_URL", "RESEND_API_KEY", "CREDENTIAL_ENCRYPTION_KEY"))
try:
    Path("/opt/write-test").write_text("forbidden")
    raise AssertionError("Root filesystem is writable")
except OSError:
    pass
try:
    socket.create_connection(("1.1.1.1",443),timeout=1).close()
    raise AssertionError("Compiler has network egress")
except OSError:
    pass
assert not Path("/tmp/shell-escape-marker").exists(), "Shell escape executed"
assert not list(Path("/tmp/jobs").iterdir()), "Jobs were not cleaned"
with tempfile.TemporaryDirectory(dir="/tmp") as directory:
    result=subprocess.run(["python3","/opt/runner.py","python3","-c", "open('large', 'wb').write(b'x'*11000000)"],cwd=directory,capture_output=True)
    assert result.returncode != 0
    assert (Path(directory)/"large").stat().st_size <= 10485760
print("PASS non-root, read-only root, no credentials/application mount, no egress, shell escape, job cleanup and output resource limit")
