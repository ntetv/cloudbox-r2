#!/usr/bin/env python3
import hashlib
import os
import pty
import select
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.environ.get("NODE", "node")
HARNESS = os.path.join(ROOT, "tests", "pty-ask-secret-harness.mjs")
CANARIES = ["pty-hidden-one", "pty-normal", "pty-hidden-two", "pty-hidden-three"]

def run(inputs):
    master, slave = pty.openpty()
    proc = subprocess.Popen([NODE, HARNESS], stdin=slave, stdout=slave, stderr=slave, cwd=ROOT, close_fds=True)
    os.close(slave)
    output = b""
    deadline = time.time() + 10
    index = 0
    while time.time() < deadline and proc.poll() is None:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            output += chunk
            if index < len(inputs):
                marker, value = inputs[index]
                if marker.encode() in output:
                    os.write(master, value)
                    index += 1
    proc.wait(timeout=2)
    os.close(master)
    return proc.returncode, output.decode(errors="replace")

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def main():
    code, output = run([
        ("hidden-1: ", (CANARIES[0] + "\n").encode()),
        ("normal: ", (CANARIES[1] + "\n").encode()),
        ("hidden-2: ", (CANARIES[2] + "\n").encode()),
        ("hidden-3: ", (CANARIES[3] + "\n").encode()),
        ("confirm [y/N]: ", b"yes\n"),
    ])
    expected = "OK " + " ".join(digest(value) for value in CANARIES)
    if code != 0 or expected not in output:
        raise SystemExit(f"pty flow failed: code={code}, output={output!r}")
    for value in (CANARIES[0], CANARIES[2], CANARIES[3]):
        if value in output:
            raise SystemExit(f"hidden canary echoed: {value}")

    for control, label in ((b"\x03", "Ctrl-C"), (b"\x04", "Ctrl-D")):
        code, output = run([("hidden-1: ", b"pty-cancel" + control)])
        if code == 0 or "EXIT" not in output:
            raise SystemExit(f"{label} cancellation failed: code={code}, output={output!r}")
        if "pty-cancel" in output:
            raise SystemExit(f"{label} canary echoed: {output!r}")
    print("pty askSecret flow, Ctrl-C, and Ctrl-D passed")

if __name__ == "__main__":
    main()
