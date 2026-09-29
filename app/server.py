"""kubelab demo app: a tiny HTTP server with knobs for exploring Kubernetes behaviour.

Endpoints
  GET /          who am I? (version, pod, node, config, visit counter)
  GET /healthz   liveness  - 200 unless /break was called
  GET /readyz    readiness - 200 once STARTUP_DELAY has passed and not toggled off
  GET /break     make /healthz fail forever (simulates a deadlock)
  GET /unready   make /readyz fail;  GET /ready  makes it pass again
  GET /burn?seconds=N   burn one CPU core for N seconds (for autoscaling)
  GET /leak?mb=N        allocate and hold N MiB of memory (for OOMKilled)
  GET /exit      exit the process with status 1 (for CrashLoopBackOff)

Environment
  VERSION        baked into the image at build time
  GREETING       message shown on /
  STARTUP_DELAY  seconds before /readyz returns 200 (default 0)
  CONFIG_FILE    file whose contents are shown on / (default /etc/kubelab/message.txt)
  REDIS_HOST     if set, / increments a visit counter in Redis
  NODE_NAME, POD_NAME, POD_NAMESPACE, POD_IP  typically injected via the Downward API
"""

import json
import os
import signal
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

STARTED = time.time()
STATE = {"healthy": True, "ready": True}
HOARD = []


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def redis_incr(host, key="visits"):
    """INCR a key using the raw Redis protocol (keeps the image dependency-free)."""
    with socket.create_connection((host, 6379), timeout=2) as s:
        s.sendall(f"*2\r\n$4\r\nINCR\r\n${len(key)}\r\n{key}\r\n".encode())
        reply = s.recv(64).decode()
    if not reply.startswith(":"):
        raise RuntimeError(reply.strip())
    return int(reply[1:].strip())


def burn(seconds):
    end = time.time() + seconds
    while time.time() < end:
        pass


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = (json.dumps(body, indent=2) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/healthz", "/readyz")):
            log(f"{self.address_string()} {fmt % args}")

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path

        if path == "/":
            body = {
                "version": os.environ.get("VERSION", "dev"),
                "greeting": os.environ.get("GREETING", "hello from kubelab"),
                "pod": os.environ.get("POD_NAME", socket.gethostname()),
                "namespace": os.environ.get("POD_NAMESPACE"),
                "node": os.environ.get("NODE_NAME"),
                "podIP": os.environ.get("POD_IP"),
                "uptimeSeconds": int(time.time() - STARTED),
            }
            cfg = os.environ.get("CONFIG_FILE", "/etc/kubelab/message.txt")
            if os.path.exists(cfg):
                with open(cfg) as f:
                    body["configFile"] = f.read().strip()
            if os.environ.get("REDIS_HOST"):
                try:
                    body["visits"] = redis_incr(os.environ["REDIS_HOST"])
                except Exception as e:  # show the error rather than failing the request
                    body["visits"] = f"error: {e}"
            return self.reply(200, body)

        if path == "/healthz":
            return self.reply(200 if STATE["healthy"] else 500, {"healthy": STATE["healthy"]})

        if path == "/readyz":
            delay = float(os.environ.get("STARTUP_DELAY", "0"))
            ok = STATE["ready"] and time.time() - STARTED >= delay
            return self.reply(200 if ok else 503, {"ready": ok})

        if path == "/break":
            STATE["healthy"] = False
            log("liveness will now fail")
            return self.reply(200, {"healthy": False})

        if path in ("/ready", "/unready"):
            STATE["ready"] = path == "/ready"
            log(f"readiness set to {STATE['ready']}")
            return self.reply(200, {"ready": STATE["ready"]})

        if path == "/burn":
            seconds = float(q.get("seconds", ["30"])[0])
            threading.Thread(target=burn, args=(seconds,), daemon=True).start()
            return self.reply(200, {"burning": seconds})

        if path == "/leak":
            mb = int(q.get("mb", ["50"])[0])
            HOARD.append(bytearray(mb * 1024 * 1024))
            total = sum(len(b) for b in HOARD) // (1024 * 1024)
            log(f"holding {total} MiB")
            return self.reply(200, {"holdingMiB": total})

        if path == "/exit":
            log("exiting with status 1 on request")
            self.reply(200, {"exiting": True})
            os._exit(1)

        return self.reply(404, {"error": "not found"})


def main():
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)

    def on_sigterm(*_):
        # Kubernetes sends SIGTERM, waits terminationGracePeriodSeconds, then SIGKILL.
        log("SIGTERM received, shutting down gracefully")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, on_sigterm)
    log(f"kubelab {os.environ.get('VERSION', 'dev')} listening on :{port}")
    server.serve_forever()
    log("bye")
    sys.exit(0)


if __name__ == "__main__":
    main()
