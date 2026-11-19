#!/usr/bin/env python3
"""Native-messaging host for HiddenTabby's agent bridge.

The browser starts this process when the extension calls connectNative. It relays
one-line JSON requests from a user-only Unix socket to the extension and
returns the extension's reply. Only the socket owner can connect.
"""
import itertools
import json
import os
import socket
import struct
import sys
import threading

RUNTIME = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
SOCK = os.path.join(RUNTIME, "hiddentabby-bridge.sock")
TIMEOUT = 60

lock = threading.Lock()
pending = {}
ids = itertools.count(1)


def send_to_browser(message):
    data = json.dumps(message).encode()
    with lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
        sys.stdout.buffer.flush()


def read_browser():
    stdin = sys.stdin.buffer
    while True:
        header = stdin.read(4)
        if len(header) < 4:
            break
        (length,) = struct.unpack("<I", header)
        message = json.loads(stdin.read(length))
        slot = pending.pop(message.get("id"), None)
        if slot:
            slot["reply"] = message
            slot["event"].set()
    os._exit(0)


def serve(conn):
    try:
        _, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid():
            return
        line = conn.makefile("rb").readline(1_000_000)
        request = json.loads(line)
        if request.get("op") not in ("list", "close"):
            reply = {"ok": False, "error": "unsupported op"}
        else:
            request["id"] = next(ids)
            slot = {"event": threading.Event(), "reply": None}
            pending[request["id"]] = slot
            send_to_browser(request)
            if slot["event"].wait(TIMEOUT):
                reply = slot["reply"]
            else:
                pending.pop(request["id"], None)
                reply = {"ok": False, "error": "timeout waiting for extension"}
        conn.sendall(json.dumps(reply).encode() + b"\n")
    except (OSError, ValueError) as error:
        try:
            conn.sendall(json.dumps({"ok": False, "error": str(error)}).encode() + b"\n")
        except OSError:
            pass
    finally:
        conn.close()


def main():
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    old = os.umask(0o177)
    server = socket.socket(socket.AF_UNIX)
    server.bind(SOCK)
    os.umask(old)
    os.chmod(SOCK, 0o600)
    server.listen(8)
    threading.Thread(target=read_browser, daemon=True).start()
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
