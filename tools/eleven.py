"""ElevenLabs voiceover, music and sound effects for the creator (needs ELEVENLABS_API_KEY).

    python tools/eleven.py --text "one line" -o vo.wav [--voice Chris]
    python tools/eleven.py --lines lines.txt --out-dir out/        (one wav per line: line<id>.wav)
    python tools/eleven.py --music --text "upbeat lo-fi, no vocals" --seconds 20 -o bgm.mp3
    python tools/eleven.py --sfx --text "soft whoosh" -o sfx.wav

Batch mode passes each line the lines either side of it (previous_text/next_text), so a
multi-line voiceover keeps one timbre and pace instead of drifting line to line.
The key comes from the environment or cc-studio's .env. Costs ElevenLabs credits.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import wave

ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")   # cc-studio's .env
API = "https://api.elevenlabs.io"
SR = 24000  # pcm_24000 -> wav via stdlib, no ffmpeg hop


def key():
    if os.environ.get("ELEVENLABS_API_KEY"):
        return os.environ["ELEVENLABS_API_KEY"].strip()
    m = None
    if os.path.exists(ENV):
        with open(ENV, encoding="utf-8") as f:
            m = re.search(r"^ELEVENLABS_API_KEY=(.+)$", f.read(), re.M)
    if not m or not m.group(1).strip():
        sys.exit("no ELEVENLABS_API_KEY: put it in cc-studio's .env (npm run setup asks for it)")
    return m.group(1).strip()


def get(path, k):
    req = urllib.request.Request(API + path, headers={"xi-api-key": k})
    return json.load(urllib.request.urlopen(req, timeout=60))


def resolve_voice(name, k):
    """Accept a raw voice_id or a case-insensitive name fragment ("will")."""
    voices = get("/v1/voices", k)["voices"]
    for v in voices:
        if v["voice_id"] == name:
            return v["voice_id"], v["name"]
    hits = [v for v in voices if name.lower() in v["name"].lower()]
    if not hits:
        sys.exit("no voice matching %r. have: %s"
                 % (name, ", ".join(v["name"].split(" -")[0] for v in voices)))
    if len(hits) > 1:
        sys.exit("ambiguous %r: %s" % (name, ", ".join(h["name"] for h in hits)))
    return hits[0]["voice_id"], hits[0]["name"]


def speak(text, out, vid, k, a, prev=None, nxt=None):
    body = {
        "text": text,
        "model_id": a.model,
        "voice_settings": {
            "stability": a.stability,
            "similarity_boost": a.similarity,
            "style": a.style,
            "use_speaker_boost": True,
            "speed": a.speed,
        },
    }
    # Prosody continuity across shots. eleven_v3 rejects both fields outright
    # ("unsupported_model"), so it is the expressive model OR the continuous
    # one, not both -- multilingual_v2 / turbo_v2_5 accept them.
    if not a.model.startswith("eleven_v3"):
        if prev:
            body["previous_text"] = prev
        if nxt:
            body["next_text"] = nxt
    if a.seed is not None:
        body["seed"] = a.seed

    req = urllib.request.Request(
        f"{API}/v1/text-to-speech/{vid}?output_format=pcm_{SR}",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": k, "content-type": "application/json"},
    )
    try:
        pcm = urllib.request.urlopen(req, timeout=180).read()
    except urllib.error.HTTPError as e:
        sys.exit("elevenlabs %d: %s" % (e.code, e.read()[:400].decode("utf-8", "replace")))

    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return len(pcm) / 2 / SR


def sfx(text, out, k, seconds, influence=0.55):
    """Generate one sound effect. Same key, different endpoint.

    Used for the ASMR cut, where the audio *is* the content: a trigger layer, an
    ambient bed and a click overlay, mixed against measured motion peaks. Ask for
    material and mic distance ("close mic", "soft", "single") -- vague prompts
    ("relaxing sound") come back as mush.
    """
    body = {"text": text, "prompt_influence": influence}
    if seconds:
        body["duration_seconds"] = seconds
    req = urllib.request.Request(
        f"{API}/v1/sound-generation?output_format=pcm_{SR}",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": k, "content-type": "application/json"},
    )
    try:
        pcm = urllib.request.urlopen(req, timeout=180).read()
    except urllib.error.HTTPError as e:
        sys.exit("elevenlabs %d: %s" % (e.code, e.read()[:400].decode("utf-8", "replace")))
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return len(pcm) / 2 / SR


def music(prompt, out, k, seconds):
    """Generate an instrumental music bed (mp3). Same key, music endpoint."""
    body = {"prompt": prompt, "music_length_ms": int(seconds * 1000), "force_instrumental": True}
    req = urllib.request.Request(
        f"{API}/v1/music?output_format=mp3_44100_128",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": k, "content-type": "application/json"},
    )
    try:
        data = urllib.request.urlopen(req, timeout=600).read()
    except urllib.error.HTTPError as e:
        sys.exit("elevenlabs %d: %s" % (e.code, e.read()[:400].decode("utf-8", "replace")))
    with open(out, "wb") as f:
        f.write(data)
    return len(data)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sfx", action="store_true", help="sound effect, not speech")
    p.add_argument("--music", action="store_true", help="instrumental music bed (mp3), not speech")
    p.add_argument("--seconds", type=float, default=None, help="--sfx / --music length")
    p.add_argument("--text")
    p.add_argument("-o", "--out")
    p.add_argument("--lines", help="file of 'id|text' rows (see lines_v2.txt)")
    p.add_argument("--out-dir")
    # Chris — picked by ear 2026-08-31 over Will/Roger/Callum for Adam.
    p.add_argument("--voice", default="Chris", help="voice id or name fragment")
    p.add_argument("--model", default="eleven_v3")
    # Defaults tuned for Adam: deadpan needs high stability and no style push.
    p.add_argument("--stability", type=float, default=0.65)
    p.add_argument("--similarity", type=float, default=0.80)
    p.add_argument("--style", type=float, default=0.0)
    p.add_argument("--speed", type=float, default=1.05)
    p.add_argument("--seed", type=int, default=1234)
    a = p.parse_args()

    k = key()

    if a.sfx:
        if not (a.text and a.out):
            sys.exit("--sfx needs --text and -o")
        print("%.2fs  %s" % (sfx(a.text, a.out, k, a.seconds), a.out))
        return

    if a.music:
        if not (a.text and a.out and a.seconds):
            sys.exit("--music needs --text (the prompt), --seconds and -o")
        print("%d bytes  %s" % (music(a.text, a.out, k, a.seconds), a.out))
        return

    vid, vname = resolve_voice(a.voice, k)
    print(f"voice: {vname}  model: {a.model}  speed {a.speed} stability {a.stability}")

    if a.text:
        if not a.out:
            sys.exit("--text needs -o")
        print("%.2fs  %s" % (speak(a.text, a.out, vid, k, a), a.out))
        return

    if not (a.lines and a.out_dir):
        sys.exit("need --text/-o or --lines/--out-dir")

    rows = []
    with open(a.lines, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if ln and "|" in ln:
                i, t = ln.split("|", 1)
                rows.append((i.strip(), t.strip()))

    os.makedirs(a.out_dir, exist_ok=True)
    total = 0.0
    for n, (i, t) in enumerate(rows):
        out = os.path.join(a.out_dir, f"line{i}.wav")
        d = speak(t, out, vid, k, a,
                  prev=rows[n - 1][1] if n else None,
                  nxt=rows[n + 1][1] if n + 1 < len(rows) else None)
        total += d
        print("  line%-3s %5.2fs  %s" % (i, d, t[:58]))
    print("%d lines, %.1fs total, ~%d credits" % (len(rows), total, sum(len(t) for _, t in rows)))


if __name__ == "__main__":
    main()
