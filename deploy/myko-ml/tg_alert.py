#!/usr/bin/env python3
"""Myko Telegram alarm sender (primary channel; WhatsApp wa_alert.py stays as backup).
Token: env MYKO_TELEGRAM_BOT_TOKEN or /home/atte/.config/myko/telegram.env (600, never logged / not in git).
Chats: env MYKO_TELEGRAM_CHAT_IDS (comma list, also read from telegram.env) + myko_settings k='telegram_chat_ids' (JSON list).
Library: send(text, buttons_key=None, chat_ids=...) -> bool. buttons_key='<pointId>:<type>' adds inline buttons
'Kuittaa' (callback ack:<key>) and 'Ohita 1 h' (mute:<key>), handled by backend/src/telegram.js (myko-telegram.service).
CLI: tg_alert.py "text"  (test send)"""
import os, sys, json, urllib.request
D=os.path.dirname(os.path.abspath(__file__))
ENVF=os.environ.get("MYKO_TELEGRAM_ENV","/home/atte/.config/myko/telegram.env"); LOG=os.path.join(D,"tg_alert.log")
def _env():
    c={}
    try:
        for l in open(ENVF,encoding="utf-8"):
            if "=" in l and not l.lstrip().startswith("#"): k,v=l.split("=",1); c[k.strip()]=v.strip()
    except OSError: pass
    return c
def _log(s):
    import datetime
    with open(LOG,"a",encoding="utf-8") as f: f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {s}\n")
def chat_ids(db_ids=()):
    e=_env(); raw=os.environ.get("MYKO_TELEGRAM_CHAT_IDS") or e.get("MYKO_TELEGRAM_CHAT_IDS","")
    ids=[x.strip() for x in raw.split(",") if x.strip()]+[str(x) for x in db_ids]
    return list(dict.fromkeys(ids))
def send(text,buttons_key=None,chat_ids_=None):
    tok=os.environ.get("MYKO_TELEGRAM_BOT_TOKEN") or _env().get("MYKO_TELEGRAM_BOT_TOKEN")
    ids=chat_ids_ if chat_ids_ is not None else chat_ids()
    if not tok or not ids: _log(f"SKIP (no token/chat ids) msg={text!r}"); return False
    ok_any=False
    for cid in ids:
        body={"chat_id":cid,"text":text[:4000]}
        if buttons_key:
            body["reply_markup"]={"inline_keyboard":[[{"text":"Kuittaa","callback_data":f"ack:{buttons_key}"[:64]},
                                                      {"text":"Ohita 1 h","callback_data":f"mute:{buttons_key}"[:64]}]]}
        try:
            req=urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",data=json.dumps(body).encode(),headers={"Content-Type":"application/json"})
            r=json.load(urllib.request.urlopen(req,timeout=15)); ok=bool(r.get("ok"))
        except Exception as ex: ok=False; r={"description":type(ex).__name__}  # exception text could contain the URL -> only the type
        _log(f"send chat={cid} ok={ok} {'' if ok else r.get('description','')} msg={text!r}"); ok_any|=ok
    return ok_any
if __name__=="__main__": print(send(" ".join(sys.argv[1:]) or "Myko test"))
