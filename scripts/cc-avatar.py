"""Build cc's avatar layers (npm run avatar runs this).

    python scripts/cc-avatar.py   -> cc-avatar/*.png + cc.ico   (needs numpy, opencv-python, pillow)

The character is drawn here, not from images, so every part can change on its own: a
matte charcoal blob with two small feet and the "pony" on top that shows the state by its
colour. cc draws the eyes itself (so they morph, blink and glide) and turns the pony about its
base for its poses (so it swings between them). All layers share one 363 x 308 canvas:
  body_<variant>.png       charcoal (default), snow, sky, mint, lavender, pink, peach, yellow
  pony_<colour>_neutral.png the pony with its soft glow. Colours are the states: blue idle,
                           green listening, yellow thinking, purple speaking, red error, orange
                           busy, pink happy, cyan focus
  glow_<colour>_neutral.png a brighter aura around the pony (faded in while cc speaks or listens)
  eyes_neutral.png         only for the app icon
  fx_<name>.png            zz, q, marks_<colour>, sparks, ring
  icon_256.png, cc.ico     the dark app icon
Shapes are shaded from their own distance field (a rounded 3D look, lit from the top left).
"""
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cc-avatar")   # arg: a preview folder
W, H, SS = 363, 308, 4                        # the canvas cc's layout expects; drawn 4x, then reduced
CX = 142                                      # the character's centre line
BODY = (CX, 207, 100, 76, 66)                 # centre x, centre y, half width, half height above / below centre
FEET = [(CX - 46, 274), (CX + 46, 274)]
BASE = (CX + 8, 136)                          # where the pony leaves the body
EYES = (CX - 21, CX + 21, 210)                # left x, right x, y

BODIES = {"charcoal": (44, 45, 51), "snow": (232, 233, 238), "sky": (47, 120, 232), "mint": (63, 178, 132),
          "lavender": (152, 108, 222), "pink": (236, 128, 176), "peach": (236, 140, 112), "yellow": (236, 190, 60)}
PONY = {"blue": (44, 125, 255), "green": (46, 209, 90), "yellow": (255, 194, 26), "purple": (155, 59, 255),
        "red": (255, 59, 48), "orange": (255, 122, 26), "pink": (255, 95, 168), "cyan": (25, 211, 240)}
# Pose: the curve's control point and tip, relative to BASE, and the bulb's radius.
POSES = {"neutral": ((-10, -40), (26, -72), 32)}   # cc turns this one for the other poses
LIGHT = np.array([-0.45, -0.65, 0.62]); LIGHT = LIGHT / np.linalg.norm(LIGHT)


def canvas():
    return np.zeros((H * SS, W * SS, 4), np.float32)


def shade(mask, rgb, gloss=0.3, ambient=0.3, roundness=1.0):
    """A mask (SS scale, 0..1) shaded as a rounded solid: height from the distance to its edge."""
    m8 = (mask > 0.5).astype(np.uint8)
    d = cv2.distanceTransform(m8, cv2.DIST_L2, 5)
    dmax = max(d.max(), 1)
    t = np.clip(d / dmax, 0, 1)
    hgt = np.sqrt(1 - (1 - t) ** 2) * dmax * roundness
    gy, gx = np.gradient(cv2.GaussianBlur(hgt, (0, 0), SS * 4))
    n = np.dstack([-gx, -gy, np.ones_like(gx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    diff = np.clip(n @ LIGHT, 0, 1)
    half = LIGHT + np.array([0, 0, 1.0]); half /= np.linalg.norm(half)
    spec = np.clip(n @ half, 0, 1) ** 28 * gloss
    col = np.array(rgb, np.float32) / 255
    out = np.zeros(mask.shape + (4,), np.float32)
    out[..., :3] = np.clip(col * (ambient + (1 - ambient) * diff)[..., None] + spec[..., None], 0, 1)
    out[..., 3] = mask
    return out


def shade_ellipsoid(cx, cy, rx, ry_top, ry_bottom, rgb, sheen=0.07, ambient=0.34):
    yy, xx = np.mgrid[0:H * SS, 0:W * SS].astype(np.float32) / SS
    ry = np.where(yy < cy, ry_top, ry_bottom)
    nx, ny = (xx - cx) / rx, (yy - cy) / ry
    r2 = nx ** 2 + ny ** 2
    nz = np.sqrt(np.clip(1 - r2, 0, 1)) * 1.15
    n = np.dstack([nx, ny, nz]); n /= np.linalg.norm(n, axis=2, keepdims=True) + 1e-6
    wrap = 0.45
    diff = np.clip((n @ LIGHT + wrap) / (1 + wrap), 0, 1) ** 1.2
    half = LIGHT + np.array([0, 0, 1.0]); half /= np.linalg.norm(half)
    spec = np.clip(n @ half, 0, 1) ** 9 * sheen
    rim = np.clip(1 - n[..., 2], 0, 1) ** 3 * 0.16             # a faint light edge
    col = np.array(rgb, np.float32) / 255
    out = np.zeros((H * SS, W * SS, 4), np.float32)
    out[..., :3] = np.clip(col * (ambient + (1 - ambient) * diff)[..., None] + (spec + rim)[..., None], 0, 1)
    out[..., 3] = np.clip((1 - r2) * 40, 0, 1)
    return out


def over(dst, src):
    a = src[..., 3:4]
    dst[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    dst[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    return dst


def ellipse_mask(cx, cy, rx, ry_top, ry_bottom=None):
    ry_bottom = ry_bottom or ry_top
    yy, xx = np.mgrid[0:H * SS, 0:W * SS].astype(np.float32) / SS
    ry = np.where(yy < cy, ry_top, ry_bottom)
    r = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    return np.clip((1 - r) * 40, 0, 1)


def save(arr, name):
    img = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGBA")
    img.resize((W, H), Image.LANCZOS).save(os.path.join(OUT, name + ".png"))


def body(rgb):
    out = canvas()
    for fx, fy in FEET:
        out = over(out, shade_ellipsoid(fx, fy, 18, 13, 13, rgb, sheen=0.05))
    cx, cy, rx, rt, rb = BODY
    return over(out, shade_ellipsoid(cx, cy, rx, rt, rb, rgb))


def pony_mask(pose):
    (c1, tip, r_tip) = POSES[pose]
    p0 = np.array(BASE, float); p1 = p0 + c1; p2 = p0 + tip
    img = Image.new("L", (W * SS, H * SS), 0); dr = ImageDraw.Draw(img)
    for i in range(120):
        t = i / 119
        p = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2
        r = 9 + (r_tip - 9) * (t ** 1.6)
        if t > 0.86:                                   # round the fat end off rather than flatten it
            r *= math.sqrt(max(0.0, 1 - ((t - 0.86) / 0.14) ** 2 * 0.55))
        dr.ellipse([(p[0] - r) * SS, (p[1] - r) * SS, (p[0] + r) * SS, (p[1] + r) * SS], fill=255)
    return np.asarray(img.filter(ImageFilter.GaussianBlur(SS * 0.6)), np.float32) / 255


def glow(mask, rgb, radius, strength):
    g = cv2.GaussianBlur(mask, (0, 0), radius * SS) * strength
    out = np.zeros(mask.shape + (4,), np.float32)
    out[..., :3] = np.array(rgb, np.float32) / 255
    out[..., 3] = np.clip(g, 0, 1)
    return out


def pill(dr, cx, cy, w, h, fill):
    dr.rounded_rectangle([(cx - w / 2) * SS, (cy - h / 2) * SS, (cx + w / 2) * SS, (cy + h / 2) * SS], radius=min(w, h) / 2 * SS, fill=fill)


def eyes(kind, col):   # the icon's eyes; cc draws its own live (same size and place)
    img = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0)); dr = ImageDraw.Draw(img)
    lx, rx, y = EYES
    pill(dr, lx, y, 18, 42, col); pill(dr, rx, y, 18, 42, col)
    return img.filter(ImageFilter.GaussianBlur(SS * 0.35))


def fx(name):
    img = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0)); dr = ImageDraw.Draw(img)
    light = (228, 228, 231, 255)
    if name == "zz":
        for (x, y, s) in ((236, 92, 12), (254, 70, 16), (276, 44, 20)):
            pts = [(x, y), (x + s, y), (x, y + s), (x + s, y + s)]
            dr.line([(px * SS, py * SS) for px, py in pts], fill=light, width=3 * SS, joint="curve")
    elif name == "q":
        dr.arc([228 * SS, 38 * SS, 252 * SS, 62 * SS], 180, 90, fill=(255, 210, 80, 255), width=5 * SS)
        dr.line([240 * SS, 62 * SS, 240 * SS, 70 * SS], fill=(255, 210, 80, 255), width=5 * SS)
        dr.ellipse([237 * SS, 76 * SS, 243 * SS, 82 * SS], fill=(255, 210, 80, 255))
    elif name.startswith("marks_"):
        c = PONY[name[6:]] + (255,)
        dr.line([226 * SS, 70 * SS, 236 * SS, 52 * SS], fill=c, width=5 * SS)
        dr.line([234 * SS, 84 * SS, 252 * SS, 76 * SS], fill=c, width=5 * SS)
    elif name == "sparks":
        for (x, y, s) in ((232, 60, 9), (252, 96, 6), (60, 112, 7)):
            c = (255, 120, 180, 255)
            dr.polygon([((x + s * math.cos(a * math.pi / 4) * (1 if a % 2 == 0 else 0.35)) * SS,
                         (y + s * math.sin(a * math.pi / 4) * (1 if a % 2 == 0 else 0.35)) * SS) for a in range(8)], fill=c)
    elif name == "ring":                    # focus: a glowing ring at the feet
        dr.ellipse([(CX - 92) * SS, 276 * SS, (CX + 92) * SS, 302 * SS], outline=(25, 211, 240, 255), width=4 * SS)
    out = img.filter(ImageFilter.GaussianBlur(SS * 0.4))
    if name == "ring":
        out = Image.alpha_composite(img.filter(ImageFilter.GaussianBlur(SS * 4)), out)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):                 # the old robot's layers go; nothing else lives here
        if f.endswith(".png") or f.endswith(".ico"):
            os.remove(os.path.join(OUT, f))
    for name, rgb in BODIES.items():
        save(body(rgb), f"body_{name}")
    for pose in POSES:
        m = pony_mask(pose)
        for name, rgb in PONY.items():
            p = over(glow(m, rgb, 7, 0.5), shade(m, rgb, gloss=0.25, ambient=0.5))
            save(p, f"pony_{name}_{pose}")
            save(glow(m, rgb, 14, 1.3), f"glow_{name}_{pose}")
    eyes("neutral", (250, 250, 252, 255)).resize((W, H), Image.LANCZOS).save(os.path.join(OUT, "eyes_neutral.png"))
    for name in ["zz", "q", "sparks", "ring"] + [f"marks_{c}" for c in PONY]:   # sound ripples: cc draws them live
        fx(name).resize((W, H), Image.LANCZOS).save(os.path.join(OUT, f"fx_{name}.png"))

    # The app icon: the idle character on a dark, blue-lit rounded square.
    char = Image.alpha_composite(Image.open(os.path.join(OUT, "body_charcoal.png")), Image.open(os.path.join(OUT, "pony_blue_neutral.png")))
    char = Image.alpha_composite(char, Image.open(os.path.join(OUT, "eyes_neutral.png"))).crop((CX - 120, 30, CX + 140, 300))
    icon = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    bg = Image.new("RGBA", (256, 256), (0, 0, 0, 0)); ImageDraw.Draw(bg).rounded_rectangle([0, 0, 255, 255], 56, fill=(14, 17, 26, 255))
    halo = Image.new("RGBA", (256, 256), (0, 0, 0, 0)); ImageDraw.Draw(halo).ellipse([40, 70, 216, 240], fill=(44, 125, 255, 90))
    bg = Image.alpha_composite(bg, halo.filter(ImageFilter.GaussianBlur(28)))
    char.thumbnail((210, 210), Image.LANCZOS)
    icon = Image.alpha_composite(icon, bg); icon.alpha_composite(char, ((256 - char.width) // 2, 256 - char.height - 14))
    mask = Image.new("L", (256, 256), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 255], 56, fill=255)
    icon.putalpha(Image.fromarray(np.minimum(np.asarray(icon.getchannel("A")), np.asarray(mask))))
    icon.save(os.path.join(OUT, "icon_256.png"))
    icon.save(os.path.join(OUT, "cc.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"{len(os.listdir(OUT))} files in {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
