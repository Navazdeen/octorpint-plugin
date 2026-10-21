"""Checks the same-origin webcam proxy (/plugin/kobra_ui/stream). Read-only: only reads the camera stream."""
import socket
import subprocess
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import testprint as t  # noqa: E402

R = []


def ok(name, cond, detail=""):
    R.append(("PASS " if cond else "FAIL ") + name + (" - " + str(detail)[:200] if detail else ""))


def get(headers, seconds):
    s = socket.create_connection(("octoprint-kobra", 5000), 5)
    s.sendall(("GET /plugin/kobra_ui/stream HTTP/1.1\r\nHost: octoprint-kobra:5000\r\n" + "".join("%s: %s\r\n" % h for h in headers) + "\r\n").encode())
    s.settimeout(3)
    data, t0 = b"", time.time()
    try:
        while time.time() - t0 < seconds:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    s.close()
    return data


def upstream_conns():
    out = subprocess.run(["ssh", "octoprint-kobra", "ss -tn state established '( dport = :8080 )' | tail -n +2 | grep -c 127.0.0.1 || true"],
                         capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip()
    return int(out or 0)


anon = get([], 2)
ok("no login -> refused", anon.split(b"\r\n", 1)[0].split(b" ")[1:2] in ([b"403"], [b"401"]), anon[:60])
base = upstream_conns()
data = get([("X-Api-Key", t.KEY)], 3)
head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1")
frames = data.count(b"\xff\xd8")
ok("logged in -> multipart stream with frames", " 200 " in head.split("\r\n")[0] and "multipart/x-mixed-replace" in head.lower() and frames >= 10, "%s | frames %d" % (head.split("\r\n")[0], frames))
time.sleep(3)
ok("closing the viewer releases the upstream camera connection", upstream_conns() <= base, "upstream before %d, after %d" % (base, upstream_conns()))
print("\n".join(R))
sys.exit(0 if all(x.startswith("PASS") for x in R) else 1)
