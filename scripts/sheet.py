"""Contact sheet: a grid of frames, each with its number and label, as one jpg.

    python scripts/sheet.py <tiles.json> <out.jpg> [columns]

tiles.json is [{"image": "<path>", "label": "<text>"}, ...]. Used to describe assets in
bulk (one image per Claude call) and to give the creator one look at a whole workspace.
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

TILE_W, TILE_H, BAR = 240, 300, 34


def main():
    tiles = json.load(open(sys.argv[1], encoding="utf-8"))
    out, cols = sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 5
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * TILE_W, rows * (TILE_H + BAR)), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 15)
    except OSError:
        font = ImageFont.load_default()
    for i, t in enumerate(tiles):
        x, y = (i % cols) * TILE_W, (i // cols) * (TILE_H + BAR)
        try:
            im = Image.open(t["image"]).convert("RGB")
            im.thumbnail((TILE_W - 8, TILE_H - 8))
            sheet.paste(im, (x + (TILE_W - im.width) // 2, y + (TILE_H - im.height) // 2))
        except Exception:
            draw.text((x + 10, y + 10), "(no frame)", fill=(160, 160, 170), font=font)
        draw.rectangle([x, y + TILE_H, x + TILE_W, y + TILE_H + BAR], fill=(39, 39, 42))
        draw.text((x + 6, y + TILE_H + 8), f"{i + 1}  {t.get('label', '')}"[:30], fill=(244, 244, 245), font=font)
    sheet.save(out, quality=82)


if __name__ == "__main__":
    main()
