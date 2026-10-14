"""Opt-in, isolated macOS WKWebView renderer profile. Never opens the user's Terax profile."""
import argparse
import ctypes
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import plistlib
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path)
parser.add_argument("--source", type=Path, help="Optional baseline checkout; its node_modules must be installed")
parser.add_argument("--revision", help="Commit label for a source archive without Git metadata")
parser.add_argument("--inspect", action="store_true", help="Keep the final frame visible for three minutes for live inspection")
parser.add_argument("--panes", choices=[1, 4], type=int, default=1)
args = parser.parse_args()
if platform.system() != "Darwin":
    raise SystemExit("This profile requires macOS, Xcode command line tools, and footprint.")
root = Path(__file__).resolve().parent
repo = root.parent.parent
output = (args.output or Path(tempfile.mkdtemp(prefix="terax-renderer-profile-"))).resolve()
output.mkdir(parents=True, exist_ok=True)
source = (args.source or repo).resolve()
dist = output / "dist"
bundle = output / "Terax Renderer Lab.app"
executable = bundle / "Contents/MacOS/renderer-lab"
executable.parent.mkdir(parents=True, exist_ok=True)
env = {**os.environ, "TERAX_PROFILE_SOURCE_ROOT": str(source), "TERAX_RENDERER_DIST": str(dist)}
with (output / "build.log").open("w") as log:
    subprocess.run(["pnpm", "exec", "vite", "build", "--config", str(root / "vite.config.ts")], cwd=repo, env=env, stdout=log, stderr=log, check=True)
    subprocess.run(["swiftc", "-module-cache-path", str(output / "swift-cache"), str(root / "Lab.swift"), "-o", str(executable)], stdout=log, stderr=log, check=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(dist), **kw)
    def log_message(self, *a):
        pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidinfo.restype = ctypes.c_int

class Coalition(ctypes.Structure):
    _fields_ = [("ids", ctypes.c_uint64 * 2), ("reserved", ctypes.c_uint64 * 3)]

def coalition(pid):
    value = Coalition()
    count = lib.proc_pidinfo(pid, 20, 0, ctypes.byref(value), ctypes.sizeof(value))
    return list(value.ids) if count == ctypes.sizeof(value) else None

def members(pid):
    owner = coalition(pid)
    if owner is None:
        raise RuntimeError("Cannot determine benchmark process ownership")
    result = [pid]
    for line in subprocess.check_output(["ps", "-axo", "pid,comm"], text=True).splitlines()[1:]:
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and "WebKit" in parts[1] and coalition(int(parts[0])) == owner:
            result.append(int(parts[0]))
    if len(result) != 4:
        raise RuntimeError(f"Expected one host and three WebKit helpers; ownership is ambiguous: {result}")
    return result

revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, capture_output=True)
diff = subprocess.run(["git", "-C", str(source), "diff", "HEAD"], capture_output=True)
if revision.returncode and not args.revision:
    raise SystemExit("Source archives require --revision to identify the baseline")
manifest = {
    "scope": "Synthetic renderer in an isolated native WKWebView, not full Terax, PTY, energy, or cross-platform qualification",
    "sourceRevision": revision.stdout.strip() if revision.returncode == 0 else args.revision,
    "revisionEvidence": "Git checkout" if revision.returncode == 0 else "Caller-labelled source archive",
    "sourceDiffSha256": hashlib.sha256(diff.stdout).hexdigest() if diff.returncode == 0 else None,
    "platform": platform.platform(),
    "inspectionEnabled": args.inspect,
    "panesPerTab": args.panes,
    "artifacts": {str(p.relative_to(dist)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(dist.rglob("*")) if p.is_file()},
    "samples": [],
}
url = f"http://127.0.0.1:{server.server_port}/?panes={args.panes}" + ("&inspect=1" if args.inspect else "")
with (bundle / "Contents/Info.plist").open("wb") as info:
    plistlib.dump({"CFBundleIdentifier": "app.crynta.terax.renderer-lab", "CFBundleExecutable": "renderer-lab", "CFBundleName": "Terax Renderer Lab", "CFBundlePackageType": "APPL", "NSHighResolutionCapable": True, "TeraxLabURL": url}, info)
command = [str(executable), url]
if args.inspect:
    command.append(str(output))
process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    with (output / "events.jsonl").open("w") as log:
        for line in process.stdout:
            log.write(line)
            log.flush()
            try:
                event = json.loads(line)
            except ValueError:
                continue
            phase = event.get("phase")
            if not phase:
                continue
            if phase == "error":
                raise RuntimeError(event)
            if phase not in {"blank", "two-blank", "streamed", "switched", "resized", "repaint-start", "repainted", "hidden", "disposed", "done"}:
                raise RuntimeError(f"Unknown benchmark phase: {phase}")
            sample_path = output / f"{phase}.json"
            ids = members(process.pid)
            command = ["footprint", "--noCategories", "--swapped", "-j", str(sample_path)]
            for pid in ids:
                command += ["-p", str(pid)]
            subprocess.run(command, stdout=subprocess.DEVNULL, check=True)
            footprint = json.loads(sample_path.read_text())
            if footprint.get("errors"):
                raise RuntimeError(footprint["errors"])
            if phase in {"streamed", "switched", "resized", "repainted"} and (
                not event["gpu"]["windowFocused"] or
                any(surface["visible"] and surface["documentSuspended"] for surface in event["surfaces"])
            ):
                raise RuntimeError("Keep the renderer fixture visible and focused during measurement")
            manifest["samples"].append({"event": event, "members": ids, "footprint": footprint})
            print(json.dumps({"phase": phase, "footprintMiB": footprint["total footprint"] / 1048576}), flush=True)
    if process.wait() != 0 or not manifest["samples"] or manifest["samples"][-1]["event"]["phase"] != "done":
        raise RuntimeError("Native renderer profile did not complete")
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    server.shutdown()
    (output / "report.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Saved {output / 'report.json'}")
