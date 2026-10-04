"""Near-duplicate check for finished videos, by matching the same picture across videos.

Whole-frame hashes miss the real failure: in the original deployment five videos reused one app
screenshot, rescaled and moved under new hook text, so every hash differed. ORB features +
a RANSAC homography find a reused screen or clip wherever and however big it appears.

  similar.py <new.mp4> <old.mp4> [...]   -> JSON {"overlap": {old: share}, "worst": ..., "share": ...}
  similar.py --table <a.mp4> <b.mp4> ... -> pairwise table (for calibration)

overlap = share of the new video's sampled frames (one a second) whose content shows up in
the old video. Run with the Python in studio.config.json paths.python (needs opencv-python).
"""
import json
import os
import sys

import cv2

MIN_INLIERS = 40   # geometric matches for two frames to show the same screen/footage
SAME_SHARE = float(os.environ.get("SIMILAR_SHARE", 0.35))  # this share of frames reused from one video makes it a near-duplicate
UNION_SHARE = 0.5  # ...or this share reused from all recent videos together

orb = cv2.ORB_create(nfeatures=900)
bf = cv2.BFMatcher(cv2.NORM_HAMMING)


def features(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    out = []
    for i in range(int(fps * 0.5), max(n - int(fps * 0.5), 1), int(fps)):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok:
            continue
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, (360, int(360 * g.shape[0] / g.shape[1])))
        kp, des = orb.detectAndCompute(g, None)
        if des is not None and len(kp) >= 20:
            out.append((kp, des))
    cap.release()
    return out


def inliers(a, b):
    (ka, da), (kb, db) = a, b
    good = [m for m, *rest in bf.knnMatch(da, db, k=2) if rest and m.distance < 0.75 * rest[0].distance]
    if len(good) < 12:
        return 0
    import numpy as np
    src = np.float32([ka[m.queryIdx].pt for m in good])
    dst = np.float32([kb[m.trainIdx].pt for m in good])
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return int(mask.sum()) if mask is not None else 0


def overlap(new, old):
    if not new or not old:
        return 0.0
    hit = sum(1 for f in new if max(inliers(f, g) for g in old) >= MIN_INLIERS)
    return hit / len(new)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--table":
        files = args[1:]
        feats = [features(f) for f in files]
        name = lambda f: f.replace("\\", "/").split("/")[-1][:-4][:28].ljust(28)
        for i in range(len(files)):
            for j in range(i + 1, len(files)):
                o = max(overlap(feats[i], feats[j]), overlap(feats[j], feats[i]))
                print(f"{name(files[i])} {name(files[j])} {o:.2f}{'  NEAR-DUPLICATE' if o >= SAME_SHARE else ''}")
    else:
        new = features(args[0])
        olds = {old: features(old) for old in args[1:]}
        res = {old: round(overlap(new, f), 2) for old, f in olds.items()}
        worst = max(res, key=res.get) if res else None
        # Reuse spread over several videos counts too: the share of frames matched in ANY of them.
        union = round(sum(1 for f in new if any(max((inliers(f, g) for g in o), default=0) >= MIN_INLIERS for o in olds.values() if o)) / len(new), 2) if new else 0.0
        print(json.dumps({"overlap": res, "worst": worst, "share": res.get(worst, 0), "union": union,
                          "near_duplicate": bool(worst and (res[worst] >= SAME_SHARE or union >= UNION_SHARE))}))
