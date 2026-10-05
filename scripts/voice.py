"""cc's offline voice: Kokoro (kokoro-onnx) kept loaded behind a tiny local HTTP server.

    POST http://127.0.0.1:4821/speak  {"text": "...", "voice": "cc_chill"}   (a preset below, or any Kokoro voice)  ->  {"path": "<wav>", "env": [...], "ms": 25}
    (env: the line's loudness every 25 ms, 0..1, which cc's sound ripples follow)
    GET  http://127.0.0.1:4821/health

cc starts it when it is not answering (pythonw, no window) and falls back to Windows'
built-in voice while it loads or if it is gone. Everything lives in cc-studio's voice/ folder
(gitignored): its own venv (onnxruntime-directml, kokoro-onnx --no-deps, numpy, soundfile,
phonemizer, espeakng-loader, dlinfo) and kokoro-v1.0.onnx + voices-v1.0.bin from
thewh1teagle/kokoro-onnx. Full precision on the CPU: ~1.5 s per sentence on the Ryzen 3600,
3x faster than the int8 model there; DirectML can't run Kokoro's ConvTranspose layers.

    voice/venv/Scripts/pythonw.exe scripts/voice.py   (npm run voice:install sets it up; cc starts it)
"""
import json
import os
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "voice")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "system.jsonl")


def note(lvl, msg, **extra):
    """The system log's shape (src/log.js); a failed write is ignored."""
    t = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": t, "src": "voice", "lvl": lvl, "msg": msg, **extra}) + "\n")
    except OSError:
        pass


t0 = time.time()
OUT = os.path.join(tempfile.gettempdir(), "cc-voice")
os.makedirs(OUT, exist_ok=True)
kokoro = Kokoro.from_session(
    ort.InferenceSession(os.path.join(HERE, "kokoro-v1.0.onnx"), providers=["CPUExecutionProvider"]),
    os.path.join(HERE, "voices-v1.0.bin"))
VOICES = set(kokoro.get_voices())
# cc's own voices: a Kokoro voice or blend, a calmer pace, and a cartoon lift. The lift plays
# the audio faster than it was made (the wav claims a higher sample rate) and has Kokoro speak
# slower by the same factor: the same pace, a higher pitch and younger, brighter formants.
#   name: (blend, pace, lift)
PRESETS = {
    "cc_chill": ({"am_puck": 0.65, "am_liam": 0.35}, 0.93, 1.14),    # cute and chill
    "cc_bright": ({"am_puck": 0.6, "am_liam": 0.4}, 1.02, 1.26),                     # cuter, more cartoon (cc's default)
    "cc_mellow": ({"am_michael": 0.7, "am_puck": 0.3}, 0.95, 1.05),  # calmer, a little deeper
}
STYLES = {k: sum(kokoro.get_voice_style(n) * w for n, w in mix.items()) for k, (mix, _, _) in PRESETS.items()}
note("info", f"Kokoro loaded in {time.time() - t0:.1f} s", pid=os.getpid())
lock = threading.Lock()   # one synthesis at a time; onnxruntime already uses every core
counter = [0]


ENV_MS = 25


def envelope(samples, rate):
    """Loudness every ENV_MS: RMS per window, scaled so ordinary speech peaks near 1."""
    n = max(1, int(rate * ENV_MS / 1000))
    x = np.asarray(samples, np.float32).reshape(-1)
    x = x[: len(x) // n * n].reshape(-1, n) if len(x) >= n else x.reshape(1, -1)
    rms = np.sqrt((x ** 2).mean(axis=1))
    top = max(float(np.percentile(rms, 98)) * 1.15, 0.02)   # headroom, so peaks keep their shape
    return [round(float(v), 2) for v in np.clip(rms / top, 0, 1)]


class Handler(BaseHTTPRequestHandler):
    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send(200, {"ok": True, "voices": sorted(VOICES)}) if self.path == "/health" else self.send(404, {"error": "not found"})

    def do_POST(self):
        # Only cc and setup on this machine: no browser page (it would send an Origin), no rebinding.
        if self.headers.get("origin") or self.headers.get("host") not in ("127.0.0.1:4821", "localhost:4821"):
            return self.send(403, {"error": "forbidden"})
        if self.path != "/speak":
            return self.send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            text = str(req.get("text", "")).strip()[:600]
            name = req.get("voice")
            if name in PRESETS:
                voice, pace, lift = STYLES[name], PRESETS[name][1], PRESETS[name][2]
            else:
                voice, pace, lift = (name if name in VOICES else "af_heart"), min(2.0, max(0.5, float(req.get("speed", 1.05)))), 1.0
            if not text:
                return self.send(400, {"error": "empty text"})
            with lock:
                samples, rate = kokoro.create(text, voice=voice, speed=pace / lift, lang="en-us")
                counter[0] = (counter[0] + 1) % 20   # a small ring of files: cc plays one while the next is written
                path = os.path.join(OUT, f"line{counter[0]}.wav")
                sf.write(path, samples, int(rate * lift))
            self.send(200, {"path": path, "env": envelope(samples, rate), "ms": ENV_MS / lift})
        except Exception as e:  # report, never crash the server
            note("error", f"speak failed: {e}"[:500])
            self.send(500, {"error": str(e)[:300]})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        ThreadingHTTPServer(("127.0.0.1", 4821), Handler).serve_forever()
    except Exception as e:   # e.g. the port is taken by another copy
        note("error", f"voice server stopped: {e}"[:500])
        raise
