"""Apply child-only limits before exec; avoids preexec_fn in a threaded server."""
import os
import resource
import sys
resource.setrlimit(resource.RLIMIT_FSIZE, (10485760, 10485760))
resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
os.execvp(sys.argv[1], sys.argv[1:])
