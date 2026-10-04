"""Understand a video clip — the analysis layer, in one place.

    python tools/analyze.py <video.mp4> [--out DIR] [--speech] [--no-ocr]
    python tools/analyze.py <dir-of-clips>/ --brief

Writes a text report, a JSON sidecar and a keyframe contact sheet.

WHY THIS EXISTS. The model driving the creator cannot watch video; it samples
frames and computes numbers. A grid of stills looks identical for a dead video and
a good one, and screen recordings easily leak private text (a bookmark bar, a mail
count, a Downloads folder, an Explorer window).

So this reports the things eyes-on-stills cannot give you:

  motion    is anything actually happening, and where is it dead
  scenes    real cut boundaries, not "the busiest 3 seconds"
  privacy   OCR over sampled frames, flagged against patterns that commonly leak
  speech    what is said and exactly when, for beat alignment
  keyframes scene-aware and deduplicated, so the sheet shows every distinct
            state instead of a fixed interval that misses cuts

Nothing here judges whether a cut *feels* right. That still needs a person.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

# ---------------------------------------------------------------- thresholds
# Calibrated on screen-recording footage; tune for yours.
DEAD = 1.0      # below this a shot reads as a still image
ALIVE = 5.0     # above this it reads as genuinely moving

# Patterns that commonly leak on screen. Deliberately noisy —
# this flags for review, it does not redact.
PII = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("inbox count", re.compile(r"\bInbox\s*\(\d+\)", re.I)),
    ("url", re.compile(r"\b(?:https?://|www\.)[^\s]{4,}", re.I)),
    ("domain", re.compile(r"\b[a-z0-9-]+\.(?:com|io|net|org|co|gg|ai)\b", re.I)),
    ("file", re.compile(r"\b[\w\-. ]{3,}\.(?:pdf|zip|exe|docx?|xlsx?|csv|png|jpe?g|mp4|txt|json|py|md)\b", re.I)),
    ("path", re.compile(r"\b[A-Z]:\\[\w\\ .-]{3,}")),
    # NOTE: no \b on the keyword classes below. OCR drops spaces between words —
    # a bookmark bar reading "Smart Portfolio | Ti..." comes back as the single
    # token "SmartPortfolioITi...", and \bPortfolio\b never matches it. That bug
    # silently under-reported the very leak this gate exists to catch.
    ("folder", re.compile(r"(?:Downloads|Documents|Desktop|OneDrive|Users)", re.I)),
    ("wifi/network", re.compile(r"(?:SSID|Wi-?Fi)", re.I)),
    ("money/account", re.compile(
        r"(?:Portfolio|Crypto|Exchange|Wallet|Balance|Invoice|Trading|Broker|Bank)", re.I)),
    ("mail", re.compile(r"(?:Inbox|Gmail|Outlook|Unread)", re.I)),
]


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout.strip()


def probe(path):
    def g(stream, fields):
        out = sh(["ffprobe", "-v", "error", "-select_streams", stream,
                  "-show_entries", fields, "-of", "default=nw=1", str(path)])
        return dict(l.split("=", 1) for l in out.splitlines() if "=" in l)

    v = g("v:0", "stream=width,height,r_frame_rate,codec_name,sample_aspect_ratio,nb_frames")
    a = g("a:0", "stream=codec_name,sample_rate,channels")
    f = dict(l.split("=", 1) for l in sh(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,size,bit_rate",
         "-of", "default=nw=1", str(path)]).splitlines() if "=" in l)
    info = {**{f"v_{k}": val for k, val in v.items()},
            **{f"a_{k}": val for k, val in a.items()},
            **f}
    if a:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path),
                              "-af", "volumedetect", "-f", "null", os.devnull],
                             capture_output=True, text=True).stderr
        for key in ("mean_volume", "max_volume"):
            m = re.search(rf"{key}:\s*(-?[\d.]+) dB", out)
            if m:
                info[key] = float(m.group(1))
    return info


def motion(path, sample=0.25):
    """Frame-to-frame difference over time. The number stills cannot give you."""
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    step = max(1, int(fps * sample))
    frames, times, i = [], [], 0
    while i < total:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, f = cap.read()
        if not ok:
            break
        frames.append(cv2.cvtColor(cv2.resize(f, (192, 126)), cv2.COLOR_BGR2GRAY).astype(np.int16))
        times.append(i / fps)
        i += step
    cap.release()
    if len(frames) < 3:
        return None
    d = np.array([np.abs(frames[j + 1] - frames[j]).mean() for j in range(len(frames) - 1)])
    t = np.array(times[:-1])
    dead = []
    run = None
    for ti, v in zip(t, d):
        if v < DEAD and run is None:
            run = ti
        elif v >= DEAD and run is not None:
            if ti - run >= 1.5:
                dead.append((round(run, 1), round(ti, 1)))
            run = None
    if run is not None and t[-1] - run >= 1.5:
        dead.append((round(run, 1), round(float(t[-1]), 1)))
    j = int(np.argmax(d))
    return {
        "median": round(float(np.median(d)), 3),
        "mean": round(float(d.mean()), 2),
        "peak": round(float(d[j]), 1),
        "peak_at": round(float(t[j]), 2),
        "dead_spans": dead,
        "series": [[round(float(a), 2), round(float(b), 2)] for a, b in zip(t, d)],
    }


def scenes(path):
    try:
        from scenedetect import detect, ContentDetector
    except ImportError:
        return None
    try:
        out = detect(str(path), ContentDetector())
    except Exception as e:  # a 4s clip with no cuts is normal, not an error
        return {"error": str(e)[:120]}
    return [[round(s.seconds, 2), round(e.seconds, 2)] for s, e in out]


def keyframes(path, cuts, max_frames=14, dedup=6.0):
    """One frame per scene, plus a density floor, then deduplicated.

    Fixed-interval sampling misses cuts and repeats static content. Sampling on
    scene change and dropping near-identical frames means the sheet shows every
    distinct state the clip actually reaches.
    """
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    dur = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) / fps

    wanted = []
    if cuts:
        for s, e in cuts:
            wanted.append(min(s + (e - s) * 0.5, dur - 0.05))
    floor = max(1.5, dur / max_frames)
    t = 0.0
    while t < dur:
        if all(abs(t - w) > floor * 0.6 for w in wanted):
            wanted.append(t)
        t += floor
    wanted = sorted(set(round(w, 2) for w in wanted if 0 <= w < dur))

    kept, prev = [], None
    for w in wanted:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(w * fps))
        ok, f = cap.read()
        if not ok:
            continue
        small = cv2.resize(f, (160, 105))
        if prev is not None and np.abs(small.astype(np.int16) - prev).mean() < dedup:
            continue
        prev = small.astype(np.int16)
        kept.append((w, f))
        if len(kept) >= max_frames:
            break
    cap.release()
    return kept


def sheet(kept, out_png, cols=5, width=340):
    if not kept:
        return None
    tiles = []
    for _, f in kept:
        h = int(f.shape[0] * width / f.shape[1])
        tiles.append(cv2.resize(f, (width, h)))
    h = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, h - t.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(0, 0, 0)) for t in tiles]
    rows = []
    for i in range(0, len(tiles), cols):
        row = tiles[i:i + cols]
        while len(row) < cols:
            row.append(np.zeros_like(tiles[0]))
        rows.append(np.hstack(row))
    cv2.imwrite(str(out_png), np.vstack(rows))
    return out_png


_ocr = None


def privacy_frames(path, every=0.6, cap=150):
    """Dense uniform sampling, for the privacy pass only.

    Keyframes are chosen to show distinct *states*, which is right for review and
    wrong for a leak: a bookmark bar visible for half a second between two
    keyframes is missed entirely. This walks the clip at a fixed short interval
    instead, so `--deep` is a real sweep rather than a spot check.
    """
    cap_v = cv2.VideoCapture(str(path))
    fps = cap_v.get(cv2.CAP_PROP_FPS) or 30
    dur = int(cap_v.get(cv2.CAP_PROP_FRAME_COUNT)) / fps
    step = max(every, dur / cap) if dur / every > cap else every
    out, t = [], 0.0
    while t < dur and len(out) < cap:
        cap_v.set(cv2.CAP_PROP_POS_FRAMES, int(t * fps))
        ok, f = cap_v.read()
        if not ok:
            break
        out.append((round(t, 2), f))
        t += step
    cap_v.release()
    return out


def ocr_scan(kept, min_conf=0.5, width=1600):
    """Read text off sampled frames and flag anything that looks private.

    `width` is the OCR input width. 1600 is the fast default; it reads a bookmark
    bar but MISSED an "Inbox (213)" line during validation, because small UI text
    needs pixels. Use --deep (2400) for a pass you intend to trust.
    """
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    hits, seen = [], set()
    for t, f in kept:
        scale = min(1.0, width / f.shape[1])
        img = cv2.resize(f, None, fx=scale, fy=scale) if scale < 1 else f
        res, _ = _ocr(img)
        for line in res or []:
            box, txt, conf = line[0], line[1], float(line[2])
            if conf < min_conf or len(txt.strip()) < 3:
                continue
            for label, pat in PII:
                m = pat.search(txt)
                if not m:
                    continue
                key = (label, m.group(0).lower())
                if key in seen:
                    continue
                seen.add(key)
                y = int(min(p[1] for p in box) / scale)
                hits.append({"t": t, "label": label, "text": txt.strip()[:90],
                             "match": m.group(0)[:60], "y": y})
    return hits


def speech(path):
    from faster_whisper import WhisperModel
    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    segs, info = model.transcribe(str(path), word_timestamps=True)
    words, text = [], []
    for s in segs:
        text.append(s.text.strip())
        for w in s.words or []:
            words.append([round(w.start, 2), round(w.end, 2), w.word.strip()])
    return {"text": " ".join(text).strip(), "words": words}


def report(path, r):
    L = []
    L.append(f"# {Path(path).name}")
    p = r["probe"]
    dur = float(p.get("duration", 0))
    L.append(f"\n## Technical")
    L.append(f"  {p.get('v_width','?')}x{p.get('v_height','?')}  "
             f"{p.get('v_r_frame_rate','?')}fps  {dur:.2f}s  "
             f"SAR {p.get('v_sample_aspect_ratio','?')}  {p.get('v_codec_name','?')}")
    if "a_codec_name" in p:
        L.append(f"  audio {p['a_codec_name']} {p.get('a_sample_rate','?')}Hz  "
                 f"mean {p.get('mean_volume','?')}dB  peak {p.get('max_volume','?')}dB")
        if isinstance(p.get("max_volume"), float) and p["max_volume"] < -6:
            L.append("  WARN quiet mix - normalise with loudnorm=I=-16:TP=-1.5")
    else:
        L.append("  no audio track")

    m = r.get("motion")
    L.append(f"\n## Motion   (dead <{DEAD}, alive >{ALIVE})")
    if not m:
        L.append("  too short to score")
    else:
        verdict = "DEAD" if m["mean"] < DEAD else ("weak" if m["mean"] < 3 else
                  ("ok" if m["mean"] < ALIVE else "alive"))
        L.append(f"  mean {m['mean']}  median {m['median']}  peak {m['peak']} at {m['peak_at']}s   -> {verdict}")
        if m["dead_spans"]:
            spans = ", ".join(f"{a}-{b}s" for a, b in m["dead_spans"][:8])
            L.append(f"  WARN still for: {spans}")

    sc = r.get("scenes")
    L.append(f"\n## Scenes")
    if sc is None:
        L.append("  scenedetect not installed")
    elif isinstance(sc, dict):
        L.append(f"  detection failed: {sc.get('error')}")
    elif not sc:
        L.append("  one continuous shot (no cuts detected)")
    else:
        L.append(f"  {len(sc)} scenes: " + ", ".join(f"{a}-{b}" for a, b in sc[:10]))

    L.append(f"\n## Privacy")
    hits = r.get("ocr")
    mode = "deep sweep" if r.get("ocr_deep") else "keyframes only"
    nf = r.get("ocr_frames", 0)
    if hits is None:
        L.append("  not scanned")
    elif not hits:
        L.append(f"  clean - nothing flagged across {nf} frames ({mode})")
        if not r.get("ocr_deep"):
            L.append("  NOTE keyframes only; re-run with --deep before trusting this")
    else:
        L.append(f"  {len(hits)} FLAGS across {nf} frames ({mode}) - review before shipping")
        for h in hits[:14]:
            L.append(f"    {h['t']:6.2f}s  y={h['y']:<5} [{h['label']}]  {h['text']}")

    sp = r.get("speech")
    if sp:
        L.append(f"\n## Speech")
        L.append(f"  \"{sp['text'][:200]}\"")
        if sp["words"]:
            L.append("  words: " + ", ".join(f"{w[2]}@{w[0]}" for w in sp["words"][:14]))

    if r.get("sheet"):
        L.append(f"\n## Keyframes\n  {len(r['keyframe_times'])} kept -> {r['sheet']}")
        L.append("  at " + ", ".join(f"{t}s" for t in r["keyframe_times"]))
    return "\n".join(L)


def analyse(path, out_dir, do_ocr=True, do_speech=False, deep=False):
    path = Path(path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    r = {"file": str(path)}
    r["probe"] = probe(path)
    r["motion"] = motion(path)
    r["scenes"] = scenes(path)
    cuts = r["scenes"] if isinstance(r["scenes"], list) else None
    kept = keyframes(path, cuts)
    r["keyframe_times"] = [round(t, 2) for t, _ in kept]
    png = out_dir / f"{path.stem}_frames.png"
    r["sheet"] = str(sheet(kept, png)) if kept else None
    if do_ocr:
        # normal: OCR the keyframes we already decoded.
        # deep: sweep the clip densely at full OCR width, because a leak that is
        # only on screen between two keyframes is invisible to the normal pass.
        frames = privacy_frames(path) if deep else kept
        r["ocr"] = ocr_scan(frames, width=2400 if deep else 1600)
        r["ocr_frames"] = len(frames)
        r["ocr_deep"] = bool(deep)
    else:
        r["ocr"] = None
    if do_speech and "a_codec_name" in r["probe"]:
        r["speech"] = speech(path)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--ocr-width", type=int, default=None)
    ap.add_argument("--speech", action="store_true")
    ap.add_argument("--brief", action="store_true", help="one line per clip")
    ap.add_argument("--deep", action="store_true",
                    help="definitive privacy pass: dense sampling at 2400px OCR width")
    a = ap.parse_args()

    t = Path(a.target)
    files = sorted(p for p in t.iterdir() if p.suffix.lower() == ".mp4") if t.is_dir() else [t]
    out_dir = Path(a.out) if a.out else (t if t.is_dir() else t.parent) / "analysis"

    all_r = []
    for f in files:
        r = analyse(f, out_dir, do_ocr=not a.no_ocr, do_speech=a.speech, deep=a.deep)
        all_r.append(r)
        if a.brief:
            m = r.get("motion") or {}
            n = len(r.get("ocr") or [])
            print(f"{f.name:34s} {float(r['probe'].get('duration',0)):6.2f}s  "
                  f"motion {m.get('mean','?'):>6}  peak {m.get('peak','?'):>6}  "
                  f"flags {n}")
        else:
            txt = report(f, r)
            print(txt + "\n")
            (out_dir / f"{f.stem}_report.txt").write_text(txt, encoding="utf-8")
    # One JSON per clip as well as the combined file. Callers that invoke this
    # once per file (map_assets.sh does) would otherwise overwrite analysis.json
    # on every call and keep only the last clip.
    for r in all_r:
        stem = Path(r["file"]).stem
        (out_dir / f"{stem}.json").write_text(json.dumps(r, indent=1), encoding="utf-8")
    (out_dir / "analysis.json").write_text(json.dumps(all_r, indent=1), encoding="utf-8")
    print(f"\nwrote {out_dir}")


if __name__ == "__main__":
    main()
