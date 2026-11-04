"""Photoreal label: text printed on a paper strip, fixed with pieces of clear tape. PNG with alpha."""
import random, sys, json
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SANS = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
MONO = "/usr/share/fonts/truetype/freefont/FreeMono.ttf"
S = 2  # supersample


def nz(w, h, scale, rng):
    a = rng.random((max(2, int(h / scale)), max(2, int(w / scale))))
    return np.asarray(Image.fromarray((a * 255).astype("uint8")).resize((w, h), Image.BICUBIC)).astype(float) / 255


def fbm(w, h, rng, scales=(64, 24, 8, 2), weights=(.45, .3, .17, .08)):
    return sum(wt * nz(w, h, sc, rng) for sc, wt in zip(scales, weights))


def label(text, font="sans", size=48, condense=0.86, seed=1, tapes=2):
    rng = np.random.default_rng(seed); r = random.Random(seed)
    fp = str(__import__("pathlib").Path(__file__).with_name("InterDisplay-Bold.otf"))
    f = ImageFont.truetype(fp, size * S)
    l, t, rr, b = f.getbbox(text)
    tw, th = rr - l, b - t
    tm = Image.new("L", (tw + 8, th + 8), 0)
    ImageDraw.Draw(tm).text((4 - l, 4 - t), text, font=f, fill=255)
    if condense != 1:
        tm = tm.resize((int(tm.size[0] * condense), tm.size[1]), Image.LANCZOS)
    tw, th = tm.size
    padx, pady = int(size * S * .42), int(size * S * .30)
    PW, PH = tw + 2 * padx, th + 2 * pady
    M = int(size * S * 1.4)
    CW, CH = PW + 2 * M, PH + 2 * M
    X0, Y0 = M, M

    # paper strip shape: scissor-cut, slightly uneven edges
    shape = Image.new("L", (CW, CH), 0)
    d = ImageDraw.Draw(shape)
    def wob(a, b, n, axis_y, off):
        pts = []
        for i in range(n + 1):
            k = i / n
            pts.append((a[0] + (b[0] - a[0]) * k + (r.uniform(-1, 1) if not axis_y else 0) * 0,
                        a[1] + (b[1] - a[1]) * k + r.uniform(-.8, .8) * S) if axis_y else
                       (a[0] + (b[0] - a[0]) * k + r.uniform(-.8, .8) * S, a[1] + (b[1] - a[1]) * k))
        return pts
    tl = (X0 + r.uniform(-2, 2) * S, Y0 + r.uniform(-1.5, 1.5) * S)
    tr = (X0 + PW + r.uniform(-2, 2) * S, Y0 + r.uniform(-1.5, 1.5) * S)
    br = (X0 + PW + r.uniform(-2, 2) * S, Y0 + PH + r.uniform(-1.5, 1.5) * S)
    bl = (X0 + r.uniform(-2, 2) * S, Y0 + PH + r.uniform(-1.5, 1.5) * S)
    poly = wob(tl, tr, 18, True, 0) + wob(tr, br, 4, False, 0) + wob(br, bl, 18, True, 0)[::1] + wob(bl, tl, 4, False, 0)
    d.polygon(poly, fill=255)
    paper = np.asarray(shape.filter(ImageFilter.GaussianBlur(.6 * S))).astype(float) / 255

    # paper colour + grain + fibres + soft crumple shading
    g = fbm(CW, CH, rng)
    fine = nz(CW, CH, 1.2, rng)
    base = np.stack([236, 236, 233], -1) * (0.93 + 0.07 * g[..., None]) * (0.97 + 0.03 * fine[..., None])
    crumple = np.asarray(Image.fromarray((fbm(CW, CH, rng, (220, 110), (.6, .4))*255).astype("uint8")).filter(ImageFilter.GaussianBlur(14))).astype(float)/255
    gy, gx = np.gradient(crumple)
    light = np.clip(1 + (gx - gy) * 160, .9, 1.06)
    rgb = base * light[..., None]
    # yellowing / dirt near edges
    dist = np.asarray(Image.fromarray((paper * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(10 * S))).astype(float) / 255
    edge_dirt = np.clip((1 - dist) * 1.6, 0, 1) * paper
    rgb = rgb * (1 - edge_dirt[..., None] * np.array([.10, .13, .2]))

    # toner text
    T = np.zeros((CH, CW))
    T[Y0 + pady:Y0 + pady + th, X0 + padx:X0 + padx + tw] = np.asarray(tm).astype(float) / 255
    holes = np.clip((nz(CW, CH, 1.4, rng) - .14) * 3.2, 0, 1)
    band = 0.82 + 0.18 * np.asarray(Image.fromarray((nz(CW, 8, 1, rng)[0:1].repeat(CH, 0) * 255).astype('uint8')).resize((CW, CH))).astype(float) / 255
    T = np.clip(T * holes * band * 1.15, 0, 1)
    T = np.asarray(Image.fromarray((T * 255).astype('uint8')).filter(ImageFilter.GaussianBlur(.55 * S))).astype(float) / 255
    speck = (rng.random((CH, CW)) > .9985) * paper
    T = np.maximum(T, speck * .7)
    ink = np.array([22, 22, 24])
    rgb = rgb * (1 - T[..., None] * .96) + ink * T[..., None] * .96

    alpha = paper.copy()

    # clear tape pieces at the ends: translucent, glossy, catches dust
    def tape_piece(cx, cy, w, h, ang):
        im = Image.new("L", (CW, CH), 0)
        dd = ImageDraw.Draw(im)
        hw, hh = w / 2, h / 2
        c, s_ = np.cos(ang), np.sin(ang)
        pts = []
        # long edges straight, short edges serrated (torn tape)
        for k in range(9):
            y = -hh + 2 * hh * k / 8
            pts.append((-hw + (1.5 * S if k % 2 else -1.5 * S), y))
        right = [(hw + (1.5 * S if k % 2 else -1.5 * S), -hh + 2 * hh * k / 8) for k in range(9)]
        pts = pts[::-1] + right
        pts = [(cx + x * c - y * s_, cy + x * s_ + y * c) for x, y in pts]
        dd.polygon(pts, fill=255)
        m = np.asarray(im.filter(ImageFilter.GaussianBlur(.5 * S))).astype(float) / 255
        # gloss band
        yy, xx = np.mgrid[0:CH, 0:CW]
        u = ((xx - cx) * -s_ + (yy - cy) * c) / max(1, hh)
        gloss = np.exp(-((u + .35) ** 2) / .03) * .55 + np.exp(-((u - .55) ** 2) / .01) * .25
        return m, gloss * m

    for k in range(tapes):
        left = (k % 2 == 0)
        tw_ = size * S * r.uniform(1.0, 1.5)
        th_ = PH * r.uniform(1.35, 1.6)
        cx = (X0 + r.uniform(-.1, .25) * tw_) if left else (X0 + PW - r.uniform(-.1, .25) * tw_)
        cy = Y0 + PH / 2 + r.uniform(-3, 3) * S
        m, gl = tape_piece(cx, cy, tw_, th_, r.uniform(-.12, .12) + (np.pi / 2 if False else 0))
        dust = (rng.random((CH, CW)) > .997) * m
        tint = np.array([226, 228, 224])
        a_t = m * (.20 + .08 * nz(CW, CH, 6, rng)) + dust * .5 + gl
        a_t = np.clip(a_t, 0, 1)
        # over paper: slightly brighten and add gloss; over concrete: translucent film
        rgb = rgb * (1 - a_t[..., None] * paper[..., None] * .5) + tint * (a_t[..., None] * paper[..., None] * .5)
        film_rgb = tint
        newA = alpha + a_t * (1 - alpha)
        rgb = (rgb * alpha[..., None] + film_rgb * (a_t * (1 - alpha))[..., None]) / np.maximum(newA[..., None], 1e-4)
        alpha = newA

    out = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), np.clip(alpha, 0, 1) * 255]).astype('uint8'), 'RGBA')
    # contact shadow (paper sits almost flat, small soft shadow)
    sh = Image.fromarray((paper * 150).astype('uint8')).filter(ImageFilter.GaussianBlur(2.2 * S))
    shadow = Image.new('RGBA', (CW, CH), (0, 0, 0, 0)); shadow.putalpha(sh)
    shadow = Image.fromarray(np.roll(np.asarray(shadow), (int(2 * S), int(1 * S)), (0, 1)))
    comp = Image.alpha_composite(shadow, out)
    comp = comp.rotate(r.uniform(-1.2, 1.2), resample=Image.BICUBIC, expand=True)
    comp = comp.crop(comp.getbbox())
    return comp.resize((comp.size[0] // S * 2 // 2, comp.size[1] // S * 2 // 2), Image.LANCZOS) if False else comp.resize((comp.size[0] * 2 // (S * 1), comp.size[1] * 2 // (S * 1)), Image.LANCZOS)


if __name__ == "__main__":
    spec = json.load(sys.stdin if sys.argv[1] == "-" else open(sys.argv[1]))
    for i, s in enumerate(spec):
        im = label(s["text"], s.get("font", "sans"), s.get("size", 48), s.get("condense", .86), s.get("seed", i + 3), s.get("tapes", 2))
        im.save(f"{sys.argv[2]}/{s['name']}.png", optimize=True)
        print(s["name"], im.size)
