#!/usr/bin/env python3
"""Shared Myko alarm notifier: Telegram (@Valvomo_bot via tg_alert) first, WhatsApp (wa_alert) only on Telegram failure.

Failure = tg_alert.send returns False (HTTP error / non-2xx, Telegram ok:false, timeout, missing token/chats)
or any exception. WhatsApp uses existing wa_alert.send. Never logs tokens.

Library: notify(text, ...) -> dict {ok, channel: 'telegram'|'whatsapp'|'none'|'dry-run', telegram_ok, ...}
Inject tg_send / wa_send for unit tests. CLI: notify_alert.py [--dry-run] "text"
"""
from __future__ import annotations
import os, sys, datetime

D = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(D, "notify_alert.log")
TG_TIMEOUT_NOTE = 10  # tg_alert uses ~10 s; documented here for callers


def _log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except OSError:
        pass


def notify(
    text,
    *,
    tg_text=None,
    buttons_key=None,
    chat_ids_=None,
    tag="ALARM ",
    bypass_rate=True,
    channels=None,
    tg_send=None,
    wa_send=None,
    log=_log,
):
    """Send Telegram first; on failure fall back to WhatsApp if enabled.

    channels: dict with telegram/whatsapp bools (default both True). If telegram disabled,
    WhatsApp is used directly when enabled. Returns outcome dict (never raises).
    """
    ch = {"telegram": True, "whatsapp": True}
    if isinstance(channels, dict):
        ch.update({k: bool(x) for k, x in channels.items() if k in ch})
    msg = text if text is not None else ""
    tg_body = tg_text if tg_text is not None else msg
    out = {"ok": False, "channel": "none", "telegram_ok": None, "whatsapp_ok": None, "error": None}

    if ch["telegram"]:
        okt, err = False, None
        try:
            if tg_send is not None:
                okt = bool(tg_send(tg_body, buttons_key=buttons_key, chat_ids_=chat_ids_))
            else:
                if D not in sys.path:
                    sys.path.insert(0, D)
                import tg_alert  # noqa: WPS433

                ids = chat_ids_
                if ids is None:
                    ids = tg_alert.chat_ids()
                okt = bool(tg_alert.send(tg_body, buttons_key=buttons_key, chat_ids_=ids))
        except Exception as ex:  # noqa: BLE001 — any transport/API failure -> fallback
            okt, err = False, f"{type(ex).__name__}"
        out["telegram_ok"] = okt
        out["error"] = err
        if okt:
            out["ok"], out["channel"] = True, "telegram"
            log(f"telegram ok tag={tag!r} msg={tg_body!r}")
            return out
        log(f"telegram FAIL tag={tag!r} err={err or 'false'} -> whatsapp fallback msg={msg!r}")
    elif ch["whatsapp"]:
        log(f"telegram disabled -> whatsapp direct tag={tag!r} msg={msg!r}")

    if ch["whatsapp"]:
        okw, status = False, None
        try:
            if wa_send is not None:
                r = wa_send(msg, bypass_rate=bypass_rate, tag=tag)
            else:
                if D not in sys.path:
                    sys.path.insert(0, D)
                from wa_alert import send as wa_send_real  # noqa: WPS433

                r = wa_send_real(msg, bypass_rate=bypass_rate, tag=tag)
            # wa_alert.send -> (ok, status, body) or injected bool/tuple
            if isinstance(r, tuple):
                okw, status = bool(r[0]), r[1] if len(r) > 1 else None
            else:
                okw = bool(r)
        except Exception as ex:  # noqa: BLE001
            okw, out["error"] = False, f"wa:{type(ex).__name__}"
        out["whatsapp_ok"] = okw
        out["ok"] = okw
        out["channel"] = "whatsapp" if okw else "none"
        log(f"whatsapp ok={okw} status={status} tag={tag!r} msg={msg!r}")
        return out

    if not ch["telegram"] and not ch["whatsapp"]:
        log(f"SKIP both channels off msg={msg!r}")
        out["error"] = "channels-off"
    return out


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    text = " ".join(args) or "Myko notify_alert test"
    if dry:
        print({"ok": True, "channel": "dry-run", "msg": text})
        raise SystemExit(0)
    r = notify(text, tag="CLI ")
    print({k: r[k] for k in ("ok", "channel", "telegram_ok", "whatsapp_ok", "error")})
    raise SystemExit(0 if r["ok"] else 1)
