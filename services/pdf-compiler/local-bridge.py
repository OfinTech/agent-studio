"""Native development worker transport; forwards only to the private compiler."""
import select
import socket
import socketserver


class Bridge(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection(("pdf-compiler", 8080), timeout=5) as upstream:
            sockets = [self.request, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 40)
                if not readable:
                    return
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.request else self.request).sendall(data)


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", 8080), Bridge) as server:
    server.serve_forever()
