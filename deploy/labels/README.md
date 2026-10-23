# Myko-tarrat – NIIMBOT D110 (12 mm)

Format: 1-bit PNG, 203 dpi. 30x12 mm = 240×96 px (default), 40x12 = 320×96, 22x12 = 176×96, 30x15, 50x30.
Left: QR code (ECC M), which holds ONLY the unit ID. Right: the ID in bold, plus 1 line (12 mm) or up to 3 lines (taller labels): strain · substrate · date.

API: `/api/labels?codes=A,B&size=30x12&format=png|zip|pdf|xlsx`, `/api/labels.csv?codes=…`
In the UI: Assistentti → after a confirmed creation, the "Tarrat" box.

## A) NIIMBOT app, batch import (easiest; Windows or phone)
1. Download "Lataa tarralista (Excel)" (.xlsx) or CSV (UTF-8 with BOM). Columns: ID, QR, Kanta, Substraatti, Pvm, Sijainti, Rivi2.
2. NIIMBOT app → New label → D110, size 30x12 (or 40x12 / 22x12).
3. Add a QR code element, a text element and optional extra text → Excel import / "Insert data" → choose the file.
4. Bind QR → QR column, text → ID, small text → Rivi2. Print all rows.

## B) PNG via niim.blue (Chrome/Edge on Windows with Bluetooth)
1. Download the PNG (one) or ZIP (many) at the right size.
2. "Tulosta Niimbotille" opens https://niim.blue → Connect (Bluetooth) → D110 → 30x12, direction Left → Image → print.

## C) Direct Web Bluetooth from Myko (not implemented)
Requires a secure context (HTTPS or localhost). Myko is served over http on the LAN → needs HTTPS (e.g. Cloudflare Tunnel)
or the Chrome flag unsafely-treat-insecure-origin-as-secure. Driver candidate: iscarelli/niimbot-web-bluetooth (MIT, D110 validated).
Lubuntu has no Bluetooth, so printing goes through the Windows PC or a phone.
