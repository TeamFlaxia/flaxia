"""Exercise the actual release binary with WebKitWebDriver; no mocked API/UI."""

import base64
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

OUTPUT = Path("native-gui-artifacts")
OUTPUT.mkdir(exist_ok=True)
BINARY = str(Path("src-tauri/target/release/flaxia").resolve())
BASE = "http://127.0.0.1:4444"
session = None


def command(method, path, data=None):
    payload = None if data is None else json.dumps(data).encode()
    request = urllib.request.Request(
        BASE + path, data=payload, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value = result.get("value")
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(json.dumps(value))
    return value


def execute(script):
    return command("POST", "/session/" + session + "/execute/sync",
                   {"script": script, "args": []})


def snapshot():
    return execute("""
        return {
          url: location.href,
          native: Boolean(window.__TAURI_INTERNALS__),
          timeline: Boolean(document.querySelector('.timeline')),
          posts: document.querySelectorAll('.post-card').length,
          offline: Boolean(document.querySelector('.offline-banner:not([hidden])')),
          text: document.body.innerText.slice(0, 12000)
        };
    """)


def capture(name):
    if session:
        try:
            state = snapshot()
            (OUTPUT / (name + ".json")).write_text(json.dumps(state, ensure_ascii=False, indent=2))
            data = command("GET", "/session/" + session + "/screenshot")
            (OUTPUT / (name + ".png")).write_bytes(base64.b64decode(data))
        except Exception as error:
            print("Screenshot diagnostic:", error, flush=True)
    subprocess.run(["import", "-window", "root", str(OUTPUT / (name + "-desktop.png"))],
                   check=False, timeout=20)


def start_app():
    global session
    value = command("POST", "/session", {
        "capabilities": {"alwaysMatch": {
            "browserName": "wry",
            "tauri:options": {"application": BINARY}
        }}
    })
    session = value["sessionId"]


def stop_app():
    global session
    if session:
        try:
            command("DELETE", "/session/" + session)
        finally:
            session = None
            # Closing Flaxia normally hides its tray window. Terminate this
            # test-owned process so the next phase really is a cold start.
            subprocess.run(["pkill", "-TERM", "-x", "flaxia"], check=False)
            time.sleep(2)


def wait_for_timeline(offline):
    deadline = time.monotonic() + 90
    state = None
    while time.monotonic() < deadline:
        state = snapshot()
        if state["native"] and state["timeline"] and state["posts"] > 0 and state["offline"] == offline:
            print(json.dumps({k: v for k, v in state.items() if k != "text"}), flush=True)
            return state
        time.sleep(1)
    raise AssertionError("Native timeline did not become ready: " + json.dumps(state, ensure_ascii=False))


firewall = False
desktop = subprocess.Popen(["openbox"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with (OUTPUT / "driver.log").open("w") as log:
    driver = subprocess.Popen(["tauri-driver"], stdout=log, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                command("GET", "/status")
                break
            except Exception:
                if driver.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("tauri-driver failed to start")
                time.sleep(1)
        start_app()
        execute("localStorage.setItem('flaxia_locale', 'ja');")
        command("POST", "/session/" + session + "/refresh", {})
        online = wait_for_timeline(False)
        time.sleep(3)
        capture("timeline-online")
        stop_app()
        # Block real outbound HTTPS, not window.fetch. The native HTTP client
        # and remote image/font requests lose the connection; local IPC remains.
        subprocess.run(["sudo", "iptables", "-I", "OUTPUT", "-p", "tcp",
                        "--dport", "443", "-j", "REJECT"], check=True)
        firewall = True
        start_app()
        offline = wait_for_timeline(True)
        assert offline["posts"] > 0 and online["posts"] > 0
        capture("timeline-offline-cold-start")
        (OUTPUT / "result.json").write_text(json.dumps({
            "binary": BINARY, "online": online, "offline_cold_start": offline,
            "network": "Outbound TCP/443 rejected by iptables for the offline phase",
        }, ensure_ascii=False, indent=2))
    except Exception:
        capture("failure")
        raise
    finally:
        if firewall:
            subprocess.run(["sudo", "iptables", "-D", "OUTPUT", "-p", "tcp",
                            "--dport", "443", "-j", "REJECT"], check=False)
        try:
            stop_app()
        finally:
            driver.terminate()
            desktop.terminate()
