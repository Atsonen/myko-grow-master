#!/usr/bin/env python3
"""Myko item labels for NIIMBOT (D110: 12 mm wide head = 96 px @ 203 dpi). 1-bit black/white PNG, landscape.
stdin JSON: {"labels":[{"code":"261023-FCR-14","lines":["#MCK · FCR","23.10.2026"]}], "size":"30x12", "format":"png|zip|pdf", "out":"/path"}
QR encodes ONLY the item ID (uppercase, alphanumeric mode) so any scanner / the Myko assistant can match it."""
import json, sys, io, zipfile
import qrcode
from PIL import Image, ImageDraw, ImageFont
DPI = 203
SIZES = {"30x12": (30, 12), "40x12": (40, 12), "22x12": (22, 12), "30x15": (30, 15), "50x30": (50, 30)}
px = lambda mm: round(mm / 25.4 * DPI)
FB = "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf"; FR = "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf"

def font_fit(path, text, max_w, max_h, start):
    s = start
    while s > 7:
        f = ImageFont.truetype(path, s); b = f.getbbox(text)
        if b[2] - b[0] <= max_w and b[3] - b[1] <= max_h: return f
        s -= 1
    return ImageFont.truetype(path, 7)

def label(code, lines, size):
    wmm, hmm = SIZES[size]; W, H = px(wmm), px(hmm)
    img = Image.new("1", (W, H), 1); d = ImageDraw.Draw(img)
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=0); q.add_data(code.upper()); q.make(fit=True)
    m = q.get_matrix(); n = len(m); pad = 4
    scale = max(1, (H - 2 * pad) // n); qs = n * scale; y0 = (H - qs) // 2
    for r, row in enumerate(m):
        for c, v in enumerate(row):
            if v: d.rectangle([pad + c * scale, y0 + r * scale, pad + (c + 1) * scale - 1, y0 + (r + 1) * scale - 1], fill=0)
    x = pad + qs + 6; tw = W - x - 3
    lines = [l for l in (lines or []) if l][: (1 if H < 100 else 3)]
    big_h = H * (0.42 if lines else 0.6)
    fc = font_fit(FB, code, tw, big_h, int(big_h * 1.3))
    bb = fc.getbbox(code); ch = bb[3] - bb[1]
    small = [font_fit(FR, l, tw, (H - ch - 10) / max(1, len(lines)), 30) for l in lines]
    hs = [f.getbbox(l)[3] - f.getbbox(l)[1] for f, l in zip(small, lines)]
    total = ch + sum(hs) + 4 * len(lines); y = (H - total) // 2
    d.text((x, y - bb[1]), code, font=fc, fill=0); y += ch + 4
    for f, l, h in zip(small, lines, hs):
        d.text((x, y - f.getbbox(l)[1]), l, font=f, fill=0); y += h + 4
    return img

def main():
    a = json.load(sys.stdin); size = a.get("size", "30x12")
    if size not in SIZES: raise SystemExit(f"size must be one of {list(SIZES)}")
    if a.get("format") == "xlsx":  # NIIMBOT app batch import (Excel): QR column = ID
        from openpyxl import Workbook
        wb = Workbook(); ws = wb.active; ws.title = "Tarrat"; cols = ["ID", "QR", "Kanta", "Substraatti", "Pvm", "Sijainti", "Rivi2"]
        ws.append(cols)
        for l in a["labels"]: ws.append([l.get(k, "") for k in ("code", "code", "strain", "substrate", "date", "location")] + [(l.get("lines") or [""])[0]])
        wb.save(a["out"]); print(json.dumps({"ok": True, "count": len(a["labels"])})); return
    imgs = [(l["code"], label(l["code"], l.get("lines"), size)) for l in a["labels"][:500]]
    fmt = a.get("format", "png"); out = a["out"]
    if fmt == "png": imgs[0][1].save(out, dpi=(DPI, DPI))
    elif fmt == "pdf": imgs[0][1].convert("L").save(out, "PDF", resolution=DPI, save_all=True, append_images=[i.convert("L") for _, i in imgs[1:]])
    elif fmt == "zip":
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for code, i in imgs:
                b = io.BytesIO(); i.save(b, "PNG", dpi=(DPI, DPI)); z.writestr(f"{code}_{size}mm.png", b.getvalue())
    print(json.dumps({"ok": True, "count": len(imgs), "px": list(imgs[0][1].size)}))
main()
