"""Runs in GitHub Actions. For every folder in inbox/:
cut the background (rembg), straighten rectangular stickers, save webp files,
give the sticker the next STK number, add it to items.json, make its ID label, remove the folder."""
import json, os, random, re, shutil, subprocess, sys
from pathlib import Path
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageOps
try:
    import pillow_heif; pillow_heif.register_heif_opener()
except Exception:
    pass
from rembg import remove, new_session

ROOT = Path(__file__).resolve().parent.parent
INBOX, ITEMS = ROOT / "inbox", ROOT / "items"
SESSION = new_session("isnet-general-use")
OUT_W = 1000


def load(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    im.thumbnail((2400, 2400))
    return im


def order(p):
    s = p.sum(1); d = np.diff(p, axis=1).ravel()
    return np.array([p[np.argmin(s)], p[np.argmin(d)], p[np.argmax(s)], p[np.argmax(d)]], np.float32)


def mask_rembg(im):
    a = np.array(remove(im, session=SESSION, post_process_mask=True))[:, :, 3]
    return (a > 127).astype(np.uint8) * 255


def mask_grabcut(im):
    """fallback for pale, see-through backs that the network misses"""
    a = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
    h, w = a.shape[:2]; sc = 1000 / max(h, w); sm = cv2.resize(a, (int(w * sc), int(h * sc)))
    m = np.zeros(sm.shape[:2], np.uint8); bg = np.zeros((1, 65)); fg = np.zeros((1, 65))
    H, W = sm.shape[:2]
    cv2.grabCut(sm, m, (int(W * .06), int(H * .06), int(W * .88), int(H * .88)), bg, fg, 6, cv2.GC_INIT_WITH_RECT)
    m = np.where((m == 1) | (m == 3), 255, 0).astype(np.uint8)
    return cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)


def biggest(m):
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return max(cs, key=cv2.contourArea) if cs else None


def quad_of(c):
    hull = cv2.convexHull(c); peri = cv2.arcLength(hull, True)
    for eps in np.linspace(.01, .06, 26):
        ap = cv2.approxPolyDP(hull, eps * peri, True)
        if len(ap) == 4:
            q = ap.reshape(-1, 2).astype(np.float32)
            if cv2.contourArea(c) / max(1, cv2.contourArea(q)) > .955:  # really a rectangle
                return order(q)
    return None


def warp(im, q):
    c = q.mean(0); q = c + (q - c) * .99                      # step in a little, no background left
    w = int((np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2)
    h = int((np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2)
    M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [w, 0], [w, h], [0, h]]))
    out = cv2.warpPerspective(np.array(im), M, (w, h), flags=cv2.INTER_LANCZOS4)
    img = Image.fromarray(out)
    m = Image.new("L", (w * 3, h * 3), 0)
    ImageDraw.Draw(m).rounded_rectangle((3, 3, w * 3 - 3, h * 3 - 3), radius=int(min(w, h) * 3 * .045), fill=255)
    img.putalpha(m.resize((w, h), Image.LANCZOS))
    return img


def freeform(im, c, m):
    x, y, w, h = cv2.boundingRect(c)
    only = np.zeros_like(m); cv2.drawContours(only, [c], -1, 255, -1)
    only = cv2.erode(only, np.ones((5, 5), np.uint8))
    only = cv2.GaussianBlur(only, (3, 3), 0)
    rgba = np.dstack([np.array(im), only])[y:y + h, x:x + w]
    return Image.fromarray(rgba, "RGBA")


def cut(path, prefer_rect=None):
    im = load(path)
    m = mask_rembg(im); c = biggest(m)
    share = cv2.contourArea(c) / (im.width * im.height) if c is not None else 0
    if c is None or share < .05 or share > .97 or (prefer_rect and quad_of(c) is None):
        m2 = mask_grabcut(im); c2 = biggest(m2)
        if c2 is not None and (c is None or quad_of(c2) is not None):
            m, c = m2, c2
    q = quad_of(c)
    out = warp(im, q) if q is not None else freeform(im, c, m)
    if out.width > OUT_W:
        out = out.resize((OUT_W, round(out.height * OUT_W / out.width)), Image.LANCZOS)
    return out, q is not None


def next_number(items):
    n = [int(m.group(1)) for it in items for m in [re.match(r"STK-(\d+)$", it["id"])] if m]
    return max(n, default=0) + 1


def main():
    items_path = ROOT / "items.json"
    items = json.loads(items_path.read_text()) if items_path.exists() else []
    done = []
    for d in sorted(p for p in INBOX.glob("*") if p.is_dir()) if INBOX.exists() else []:
        meta = json.loads((d / "meta.json").read_text())
        num = next_number(items); sid = f"STK-{num:04d}"; base = f"items/{num:04d}"
        files = meta["files"]
        front_f = next(f for f in files if f.startswith("front"))
        front, rect = cut(d / front_f)
        front.save(ROOT / f"{base}-front.webp", quality=88)
        it = {"id": sid, "city": meta["city"], "street": meta["street"], "country": meta.get("country", ""),
              "lat": meta.get("lat"), "lon": meta.get("lon"), "date": meta["date"],
              "year": int(meta["date"][-4:]) if re.search(r"\d{4}$", meta["date"]) else 2026,
              "type": meta["type"], "under": "", "note": meta.get("note", ""), "face": "L",
              "w": round(random.uniform(.40, .52), 2), "ar": round(front.height / front.width, 3),
              "x": round(random.uniform(.05, .2), 2), "rot": round(random.uniform(-2, 2), 1),
              "img": f"{base}-front.webp", "details": []}
        back_f = next((f for f in files if f.startswith("back")), None)
        if back_f:
            back, _ = cut(d / back_f, prefer_rect=rect)
            back.save(ROOT / f"{base}-back.webp", quality=88)
            it["back"] = f"{base}-back.webp"; it["backAr"] = round(back.height / back.width, 3)
        for k, f in enumerate(sorted(x for x in files if x.startswith("detail"))):
            im = load(d / f); im.thumbnail((1100, 1100))
            p = f"{base}-detail{k + 1}.webp"; im.save(ROOT / p, quality=84); it["details"].append(p)
        subprocess.run([sys.executable, str(ROOT / "tools/make_tape2.py"), "-", str(ROOT / "tape")],
                       input=json.dumps([{"name": sid, "text": sid, "font": "bold", "size": 40, "condense": .96, "seed": num, "tapes": 0}]),
                       text=True, check=True)
        items.insert(0, it)
        done.append({"id": sid, "chat": meta.get("chat")})
        shutil.rmtree(d)
        print("added", sid)
    items_path.write_text(json.dumps(items, ensure_ascii=False, indent=1))
    (ROOT / ".done.json").write_text(json.dumps(done))


if __name__ == "__main__":
    ITEMS.mkdir(exist_ok=True)
    main()
