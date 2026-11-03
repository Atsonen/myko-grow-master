#!/usr/bin/env python3
"""Live alarm check for Myko measurement points (systemd user timer, every minute).
Points: Kylmäsäilytystila 1 (ColdStorage1, dl02, absolute thresholds) and Terrario 1 (Terrario1, dl00,
thresholds relative to setpoint SP). Control values ON/HEAT/COOL/SP are owned by Myko (DB table
alarm_point_controls, edited from the dashboard) and merged into the published 16-bit word:
  bits 0-6 alarms (point specific), bit7 ON, bit8 HEAT, bit9 COOL, bits10-14 SP (0-30), bit15 WA_DISABLED (WhatsApp alarms disabled, = <key>dis)
  (toggles every live run).
PLC topic (retained, flat JSON, short keys, integers):
  Sensors/Mykovalvomo/Ctrl = {"Heartbeat":<counter 0..65535>,"F1":<ColdStorage1 word>,"T1":<Terrario1 word>}  (exact key order; WA-disabled = bit15)
WhatsApp alarms can be disabled for a limited time (alarms_disabled_until): only WhatsApp is suppressed;
alarm bits, JSON and alarm_events keep working normally;
automatic re-enable at expiry with a short WhatsApp notice.
Per-point <topic>/json (retained) is kept for the Myko dashboard.
  alarm_points_check.py                       live: evaluate, WhatsApp via wa_alert.send, MQTT publish
  alarm_points_check.py --no-wa               live run, WhatsApp only logged (tests)
  alarm_points_check.py --dry-run [--no-publish] [--point ID]   print state/would-be messages, state untouched
  alarm_points_check.py --sim START END [--point ID]            replay history (Helsinki times), no sends
DB credentials are read at runtime from /opt/myko/backend/.env; password via MYSQL_PWD env, never printed.
Replaces cold_alarm_check.py (kept for reference); F1 keeps its state/log files.
PID alarm points F1_PID / T1_PID are evaluated by the Myko backend (backend/src/pid.js, retained
Myko/Alarms/<key>_PID/json -> alarm_points); this script only sends their WhatsApp messages (new / 60 min
reminder / clear, plus re-notify when new ErrorBits appear), muted with the parent point's alarms_disabled_until.
SATUROITUNUT is log-only (no WhatsApp).
Alarm policy (2026-10-24, F1/T1 are in outdoor temperature): F1 warming is not dangerous, T1 cooling is critical only
near freezing; ~2 °C deviations only slow the process -> WARN bits are MQTT/PLC-only, F1 HIGH (>=SP+4) and T1 LOW
(<=SP-4) are low-priority notices, F1 CRIT is MQTT-only, T1 COLD = critical below 5 °C. Overridable with
myko_settings k='alarm_policy' JSON, e.g. {"F1":{"high_delta_min":5},"T1":{"cold_c":4}}.
FLATLINE (2026-11-03): any value change resets the timer; SensorBlock Uptime increasing => healthy;
device flatline only if Uptime frozen ~3 min; value stagnation while Uptime grows uses configurable limit (default 30 min).
Override with myko_settings k='flatline_policy' JSON.
Reminders: active alarms are repeated every REMIND_MIN as ONE combined WhatsApp, one short line per alarm.
Channels (2026-10-24): Telegram (tg_alert.py, @Valvomo_bot) is the primary channel, WhatsApp the backup; both on by default,
switchable with myko_settings k='alarm_channels' {"telegram":true,"whatsapp":true}. Same policy (wa_skip/low_prio) for both.
Telegram alarm messages are one line and carry inline buttons Kuittaa / Ohita 1 h (handled by backend/src/telegram.js,
stored in myko_settings k='telegram_alarm_acks' {"<pointId>:<type>":{"acked_at","muted_until"}}): an acked alarm gets no
reminders while it stays active (entry removed when it clears), a muted one none until muted_until.
Transient alarms: an alarm that clears within TRANSIENT_MIN minutes and never got a reminder is treated as transient:
Telegram gets only a short one-line note, its ack/mute state is dropped (auto-acknowledged) and no reminders follow."""
import os, sys, json, bisect, subprocess, argparse, datetime as dt
from zoneinfo import ZoneInfo
D=os.path.dirname(os.path.abspath(__file__))
HEL=ZoneInfo("Europe/Helsinki"); UTC=dt.timezone.utc
REMIND_MIN=60
# FLATLINE (2026-11-03): short value-flat removed. Any value change resets the stuck timer.
# If the source SensorBlock Uptime is increasing -> healthy (no short flatline).
# Device alarm only when Uptime unchanged for uptime_stuck_min (~3 min).
# Pure value stagnation while Uptime grows -> long configurable limit (default 6 h).
# Override with myko_settings k='flatline_policy' JSON.
FLAT_DEFAULTS={
 "value_eps":0.0,          # 0 = any inequality counts as alive (even 0.01 °C)
 "value_flat_min":30,      # minutes of unchanged value while SB healthy -> MQTT FLATLINE
 "wa_min":30,              # same for WhatsApp FLATLINE_WA
 "uptime_stuck_min":3,     # minutes of unchanged SB Uptime -> device FLATLINE (+ WA)
 "sb_api":"http://127.0.0.1:3010/api/sensorblock",
 "sources":{
   "ColdStorage1":{"device":"SensorBlock_1","field":"DStemp1"},
   "Terrario1":{"device":"SensorBlock_1","field":"DStemp2"},
 }}
# Legacy names kept as aliases of the long value-flat limits (for msg text fallback)
FLAT_MQTT_MIN=FLAT_DEFAULTS["value_flat_min"]; FLAT_WA_MIN=FLAT_DEFAULTS["wa_min"]
MQTT_ONLY={"FLATLINE"}
MQTT_HOST,MQTT_PORT="192.168.1.51","1883"
SB_UP_STATE=os.path.join(D,"sb_uptime_state.json")
_ASSUME_SB_OK=False  # set True in --sim so history replay assumes healthy SensorBlock
CTRL_BITS={"ON":7,"HEAT":8,"COOL":9}; SP_SHIFT=10; SP_MASK=0x1F; DIS_BIT=15
HB_STATE=os.path.join(D,"heartbeat_state.json")
POLICY_DEFAULTS={
 "F1":{"high_delta_min":4.0,"high_min":30,"wa_skip":["WARN","CRIT"],"low_prio":["HIGH"]},
 "T1":{"low_delta_min":4.0,"low_min":30,"cold_c":5.0,"wa_skip":["WARN"],"low_prio":["LOW"]}}
_POL=None
def policy(key):
    """Effective alarm policy for PLC key F1/T1: code defaults, overridden by myko_settings k='alarm_policy' (JSON)."""
    global _POL
    if _POL is None:
        _POL={k:dict(v) for k,v in POLICY_DEFAULTS.items()}
        try:
            raw=mysql("SELECT v FROM myko_settings WHERE k='alarm_policy'").strip()
            if raw:
                for k,v in json.loads(raw).items():
                    if k in _POL and isinstance(v,dict): _POL[k].update(v)
        except Exception: pass
    return _POL.get(key,{})
REMIND_LINES=[]  # combined reminder: one line per active alarm
TRANSIENT_MIN=10  # alarm cleared within this many minutes without a reminder = transient (short note only, auto-acked)
_SET={}
def setting(k,default):
    """myko_settings JSON value (cached per run)."""
    if k not in _SET:
        try: raw=mysql(f"SELECT v FROM myko_settings WHERE k='{k}'").strip(); _SET[k]=json.loads(raw) if raw else default
        except Exception: _SET[k]=default
    return _SET[k]
def channels():
    c={"telegram":True,"whatsapp":True}; v=setting("alarm_channels",{})
    if isinstance(v,dict): c.update({k:bool(x) for k,x in v.items() if k in c})
    return c

def flat_policy():
    """Effective flatline policy: code defaults, overridden by myko_settings k='flatline_policy'."""
    p={k:(dict(v) if isinstance(v,dict) else v) for k,v in FLAT_DEFAULTS.items()}
    p["sources"]={k:dict(v) for k,v in FLAT_DEFAULTS["sources"].items()}
    v=setting("flatline_policy",{})
    if isinstance(v,dict):
        for k,x in v.items():
            if k=="sources" and isinstance(x,dict):
                for pid,src in x.items():
                    if isinstance(src,dict): p["sources"].setdefault(pid,{}).update(src)
            elif k in p and not isinstance(p[k],dict):
                p[k]=type(FLAT_DEFAULTS[k])(x) if k in FLAT_DEFAULTS else x
            else:
                p[k]=x
    return p

def _load_sb_up():
    try:
        if os.path.exists(SB_UP_STATE): return json.load(open(SB_UP_STATE))
    except Exception: pass
    return {}

def _save_sb_up(d):
    try: json.dump(d,open(SB_UP_STATE,"w"),indent=1)
    except Exception: pass

def fetch_sb_item(device, api):
    """Live SensorBlock item from Myko API (Uptime + temps). None on failure."""
    try:
        import urllib.request
        with urllib.request.urlopen(api, timeout=3) as r:
            data=json.loads(r.read().decode())
        for it in data.get("items") or []:
            if it.get("device")==device: return it
    except Exception: return None
    return None

def sb_health(device, now, persist=True):
    """Track SensorBlock Uptime across runs.
    Returns dict: ok (Uptime increasing recently), stuck (Uptime frozen), stuck_sec, uptime, unknown."""
    if _ASSUME_SB_OK or not device:
        return {"ok":True,"stuck":False,"stuck_sec":0,"uptime":None,"unknown":False,"assume":True}
    api=flat_policy().get("sb_api") or FLAT_DEFAULTS["sb_api"]
    it=fetch_sb_item(device, api)
    if not it:
        return {"ok":False,"stuck":False,"stuck_sec":0,"uptime":None,"unknown":True}
    vals=it.get("values") or {}
    up=vals.get("Uptime")
    try: up=int(up) if up is not None else None
    except Exception: up=None
    st=_load_sb_up(); prev=st.get(device) or {}
    changed_at=prev.get("changed_at"); last_up=prev.get("uptime")
    if up is None:
        return {"ok":False,"stuck":False,"stuck_sec":0,"uptime":None,"unknown":True}
    if last_up is None or up!=last_up:
        # Uptime moved (or first sample / reboot if up < last) -> healthy pulse
        changed_at=now.isoformat(); growing=True
    else:
        growing=False
        try: t0=dt.datetime.fromisoformat(changed_at) if changed_at else now
        except Exception: t0=now
        if t0.tzinfo is None: t0=t0.replace(tzinfo=UTC)
    if persist:
        st[device]={"uptime":up,"changed_at":changed_at or now.isoformat(),"seen_at":now.isoformat(),
                    "ageMs":it.get("ageMs"),"stale":bool(it.get("stale"))}
        _save_sb_up(st)
    try: t0=dt.datetime.fromisoformat(changed_at) if changed_at else now
    except Exception: t0=now
    if t0.tzinfo is None: t0=t0.replace(tzinfo=UTC)
    stuck_sec=max(0,(now-t0).total_seconds()) if not growing else 0
    stuck_lim=float(flat_policy().get("uptime_stuck_min",3))*60
    stuck=stuck_sec>=stuck_lim
    return {"ok":(not stuck) and (growing or stuck_sec<stuck_lim),"stuck":stuck,
            "stuck_sec":stuck_sec,"stuck_since":t0 if stuck else None,
            "uptime":up,"unknown":False,"growing":growing}

def value_flat_since(rows, last_v, eps=0.0):
    """Earliest timestamp of the trailing run of unchanged values. Any change > eps resets."""
    st=None
    for t,v in reversed(rows):
        same=(v==last_v) if not eps else abs(v-last_v)<=eps
        if same: st=t
        else: break
    return st

def _acks():
    v=setting("telegram_alarm_acks",{}); return v if isinstance(v,dict) else {}
def suppressed(key,now):
    """True when the alarm was acknowledged (Kuittaa) or muted (Ohita 1 h) in Telegram -> no reminder line."""
    a=_acks().get(key) or {}
    if a.get("acked_at"): return True
    mu=a.get("muted_until")
    try: return bool(mu) and dt.datetime.fromisoformat(mu.replace("Z","+00:00"))>now
    except Exception: return False
def clear_ack(key):
    """Alarm cleared -> forget its ack/mute (next occurrence alarms again)."""
    try:
        raw=mysql("SELECT v FROM myko_settings WHERE k='telegram_alarm_acks'").strip(); d=json.loads(raw) if raw else {}
        if key in d:
            d.pop(key); v=json.dumps(d).replace("\\","\\\\").replace("'","''")
            mysql(f"UPDATE myko_settings SET v='{v}' WHERE k='telegram_alarm_acks'"); _SET.pop("telegram_alarm_acks",None)
    except Exception: pass
def point_id(P): return next((k for k,v in POINTS.items() if v["topic"]==P["topic"]),P["name"])
PLC_TOPIC="Sensors/Mykovalvomo/Ctrl"; PLC_KEYS={"ColdStorage1":"F1","Terrario1":"T1"}  # point id -> PLC key (backend uses the same map)

def num(x):
    """9.0 -> '9', 22.5 -> '22,5' (Finnish decimal comma)"""
    return str(int(x)) if float(x).is_integer() else f"{x:.1f}".replace(".",",")

# Limits are relative to setpoint SP and come from alarm_point_controls (edited in the dashboard):
#   WARN: SP±warn_delta (warn_both=1) or SP+warn_delta (warn_both=0) for warn_min; HIGH: SP+high_delta for high_min;
#   LOW: SP-low_delta for low_min. CRIT / FREEZE / COLD are absolute.
def warn_rule(c,both_label):
    sp,d=c["setpoint"],c["warn_delta"]
    if c["warn_both"]: return (both_label(sp,d),lambda v:abs(v-sp)>d,c["warn_min"])
    return (f"VAROITUS: yli {num(sp+d)} °C",lambda v:v>sp+d,c["warn_min"])
def f1_rules(c):
    sp=c["setpoint"]; pol=policy("F1"); hd=max(c["high_delta"],float(pol.get("high_delta_min",0))); hm=max(c["high_min"],int(pol.get("high_min",0)))
    return {
     "CRIT":("HYVIN KORKEA: yli 14 °C",lambda v:v>14,3),
     "HIGH":(f"KORKEA: yli {num(sp+hd)} °C",lambda v:v>sp+hd,hm),
     "WARN":warn_rule(c,lambda sp,d:f"VAROITUS: poikkeama asetusarvosta {num(sp)} °C yli {num(d)} °C"),
     "LOW":(f"MATALA: alle {num(sp-c['low_delta'])} °C",lambda v:v<sp-c["low_delta"],c["low_min"]),
     "FREEZE":("JÄÄTYMINEN: 0 °C tai alle",lambda v:v<=0,0)}
def t1_rules(c):
    sp=c["setpoint"]; pol=policy("T1"); ld=max(c["low_delta"],float(pol.get("low_delta_min",0))); lm=max(c["low_min"],int(pol.get("low_min",0))); cc=float(pol.get("cold_c",5.0))
    return {
     "CRIT":("KRIITTINEN: yli 30 °C",lambda v:v>30,3),
     "HIGH":(f"KORKEA: yli {num(sp+c['high_delta'])} °C (asetusarvo {num(sp)} °C)",lambda v:v>sp+c["high_delta"],c["high_min"]),
     "WARN":warn_rule(c,lambda sp,d:f"VAROITUS: poikkeama asetusarvosta {num(sp)} °C yli {num(d)} °C"),
     "LOW":(f"MATALA: alle {num(sp-ld)} °C (asetusarvo {num(sp)} °C)",lambda v:v<sp-ld,lm),
     "COLD":(f"KRIITTINEN, jäätymisvaara: alle {num(cc)} °C",lambda v:v<cc,3)}

POINTS={
 "ColdStorage1":dict(name="Kylmäsäilytystila 1",var="dl02",topic="Myko/Alarms/ColdStorage1",rules=f1_rules,
   bits={"WARN":0,"HIGH":1,"CRIT":2,"LOW":3,"FREEZE":4,"FLATLINE":5,"STALE":6},instant={"FREEZE"},
   state="cold_alarm_state.json",log="cold_alarm.log",plc="F1",
   defaults=dict(on=1,heat=0,cool=0,setpoint=8,warn_delta=1.0,warn_min=30,warn_both=0,high_delta=3.0,high_min=10,low_delta=3.0,low_min=3,disabled_until=None)),
 # Terrario1 temp = SensorBlock_1 DStemp2 -> datalogger dl00 (same FLATLINE policy as ColdStorage1)
 "Terrario1":dict(name="Terrario 1",var="dl00",topic="Myko/Alarms/Terrario1",rules=t1_rules,
   bits={"WARN":0,"HIGH":1,"CRIT":2,"LOW":3,"COLD":4,"FLATLINE":5,"STALE":6},instant=set(),
   state="terrario1_alarm_state.json",log="terrario1_alarm.log",plc="T1",
   defaults=dict(on=1,heat=0,cool=0,setpoint=25,warn_delta=1.5,warn_min=30,warn_both=1,high_delta=3.0,high_min=10,low_delta=3.0,low_min=10,disabled_until=None)),
}

def env():
    c={}
    for l in open("/opt/myko/backend/.env",encoding="utf-8"):
        l=l.strip()
        if l and not l.startswith("#") and "=" in l: k,v=l.split("=",1); c[k.strip()]=v.strip().strip('"\'')
    return c
def mysql(q):
    c=env(); e=dict(os.environ,MYSQL_PWD=c.get("DB_PASSWORD",""))
    out=subprocess.run(["mysql","-h",c.get("DB_HOST","localhost"),"-P",c.get("DB_PORT","3306"),"-u",c["DB_USER"],c.get("DB_NAME","myko_valvomo"),
        "-B","-N","-e",q],env=e,capture_output=True,text=True,timeout=30)
    if out.returncode: raise RuntimeError("mysql error: "+out.stderr.strip()[:200])
    return out.stdout
def query(var,start_utc,end_utc):
    q=("SELECT DATE_FORMAT(timestamp,'%Y-%m-%d %H:%i:%s'), numeric_value FROM datalogger_values "
       f"WHERE source_id='src-datalogger' AND variable_key='{var}' AND numeric_value>=-50 "
       f"AND timestamp>='{start_utc:%Y-%m-%d %H:%M:%S}' AND timestamp<='{end_utc:%Y-%m-%d %H:%M:%S}' ORDER BY timestamp")
    rows=[]
    for l in mysql(q).splitlines():
        t,v=l.split("\t"); rows.append((dt.datetime.strptime(t,"%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC),float(v)))
    return rows
def controls(pid,P):
    try:
        out=mysql("SELECT on_state,heat,cool,setpoint,warn_delta,warn_min,warn_both,high_delta,high_min,low_delta,low_min,"
                  f"COALESCE(DATE_FORMAT(alarms_disabled_until,'%Y-%m-%d %H:%i:%s'),'') FROM alarm_point_controls WHERE point_id='{pid}'").strip("\n")
        if out:
            f=out.split("\t")
            o,h,c,sp=[int(float(x)) for x in f[:4]]
            du=dt.datetime.strptime(f[11],"%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC) if f[11] else None
            return dict(on=o,heat=h,cool=c,setpoint=max(0,min(30,sp)),warn_delta=float(f[4]),warn_min=int(f[5]),warn_both=int(f[6]),
                        high_delta=float(f[7]),high_min=int(f[8]),low_delta=float(f[9]),low_min=int(f[10]),disabled_until=du)
    except Exception as ex: log(P,f"controls read error {ex}")
    return dict(P["defaults"])
def hc_limits_mode(plc_key):
    """True when the backend (pid.js) does H/C via PID_Temp output limits -> Ctrl HEAT bit8 / COOL bit9 are constant 1."""
    try: return mysql(f"SELECT mode FROM pid_output_limits WHERE pid_key='{plc_key}'").strip()=="limits"
    except Exception: return False
def ctrl_word(c,plc_key=None):
    lim=bool(plc_key) and hc_limits_mode(plc_key)
    heat=1 if lim else c["heat"]&1; cool=1 if lim else c["cool"]&1
    return (c["on"]&1)<<7 | heat<<8 | cool<<9 | (c["setpoint"]&SP_MASK)<<SP_SHIFT
def hel(t): return t.astimezone(HEL).strftime("%d.%m. %H:%M")

def evaluate(P,rows,now,ctrl):
    """rows: (utc_ts,value) up to now. Returns {type:(active,info)}"""
    res={}
    if not rows: return {"STALE":(True,{"since":None})}
    last_t,last_v=rows[-1]
    res["STALE"]=((now-last_t).total_seconds()>=600,{"since":last_t,"v":last_v})
    for k,(lab,f,mins) in P["rules"](ctrl).items():
        start=None
        for t,v in reversed(rows):
            if f(v): start=t
            else: break
        active=start is not None and (now-start).total_seconds()>=mins*60 and f(last_v)
        if k in P["instant"]: active=f(last_v)
        res[k]=(active,{"since":start,"v":last_v,"max":max(v for t,v in rows if start and t>=start) if start else last_v,"min":min(v for t,v in rows if start and t>=start) if start else last_v})
    # FLATLINE: SensorBlock Uptime-aware (see FLAT_DEFAULTS / flatline_policy).
    # Applies equally to ColdStorage1 and Terrario1 (sources map). Independent of ctrl.on / PID State/Mode:
    # temperature + FLATLINE/STALE bits stay evaluated when the point or PID is OFF.
    pol=flat_policy(); eps=float(pol.get("value_eps") or 0.0)
    st=value_flat_since(rows, last_v, eps)
    flat_sec=(last_t-st).total_seconds() if st is not None else 0.0
    pid=point_id(P); src=(pol.get("sources") or {}).get(pid) or {}
    device=src.get("device")
    # persist uptime only on live runs (dry-run/sim pass persist=False via _ASSUME or flag)
    persist=not _ASSUME_SB_OK and not getattr(evaluate,"_no_persist",False)
    health=sb_health(device, now, persist=persist) if device else {"ok":True,"stuck":False,"stuck_sec":0,"uptime":None,"unknown":True}
    v_lim=float(pol.get("value_flat_min",360))*60
    wa_lim=float(pol.get("wa_min",360))*60
    device_flat=bool(health.get("stuck"))
    # Healthy / unknown SB: only long value-stagnation alarms (no short 15 min flat)
    value_mqtt=flat_sec>=v_lim
    value_wa=flat_sec>=wa_lim
    info={"since":(health.get("stuck_since") if device_flat else st),"v":last_v,
          "reason":("uptime" if device_flat else "value"),"uptime":health.get("uptime"),
          "flat_min":int(flat_sec//60),"value_limit_min":int(v_lim//60),"uptime_stuck_min":int(pol.get("uptime_stuck_min",3))}
    res["FLATLINE"]=(device_flat or value_mqtt,info)
    res["FLATLINE_WA"]=(device_flat or value_wa,info)
    if res["STALE"][0]:
        for k in ("FLATLINE","FLATLINE_WA"): res[k]=(False,res[k][1])
    return res

def msg(P,ctrl,kind,typ,info,now):
    NAME=P["name"]; v=info.get("v"); cur=f"Nyt {v:.1f} °C ({hel(now)})" if v is not None else f"({hel(now)})"
    since=f"alkaen {hel(info['since'])}" if info.get("since") else ""
    if typ=="STALE": d=f"ei uusia mittauksia {since.replace('alkaen','viimeisin')}".strip(); lab="YHTEYSVIKA: ei dataa 10 min"; cur=f"Viimeisin arvo {v:.1f} °C" if v is not None else ""
    elif typ in ("FLATLINE","FLATLINE_WA"):
        reason=info.get("reason") or "value"; lim=info.get("value_limit_min") or flat_policy().get("wa_min",FLAT_WA_MIN)
        if reason=="uptime":
            lab=f"ANTURIVIKA?: SensorBlock Uptime jumissa {info.get('uptime_stuck_min') or flat_policy().get('uptime_stuck_min',3)} min"
            d=f"Uptime ei kasva {since}"+(f" (Uptime={info.get('uptime')})" if info.get("uptime") is not None else "")
        else:
            lab=f"ANTURIVIKA?: arvo ei muutu {lim} min (SB OK)"
            d=f"sama arvo {since}"
    else:
        lab=P["rules"](ctrl)[typ][0]; dur=int((now-info['since']).total_seconds()//60) if info.get("since") else 0
        low=typ in ("LOW","FREEZE","COLD") or (typ=="WARN" and v is not None and v<ctrl["setpoint"])
        ext=("min",info.get("min",v)) if low else ("max",info.get("max",v)); d=f"{dur} min {since}, {ext[0]} {ext[1]:.1f} °C"
    head={"new":"🚨 HÄLYTYS","remind":"⏰ MUISTUTUS, hälytys jatkuu","clear":"✅ PALAUTUNUT"}[kind]
    if kind=="new" and typ in policy(P.get("plc","")).get("low_prio",[]): head="ℹ️ ILMOITUS"
    if kind=="clear": return f"{head}: {NAME} – {lab.split(':')[0]} ohi. {cur}"
    return f"{head}: {NAME} – {lab}. {d}. {cur}"

def remind_line(P,ctrl,typ,info):
    """One short line for the combined reminder: point, what, value vs SP."""
    v=info.get("v"); key=P.get("plc",P["name"])
    if typ=="STALE": return f"• {key} {P['name']}: ei dataa"+(f" (viim. {num(round(v,1))} °C)" if v is not None else "")
    if typ in ("FLATLINE","FLATLINE_WA"): return f"• {key} {P['name']}: anturi jumissa {num(round(v,1)) if v is not None else '?'} °C"
    lab=P["rules"](ctrl)[typ][0].split(":")[0]
    return f"• {key} {P['name']}: {lab} {num(round(v,1)) if v is not None else '?'} °C (SP {num(ctrl['setpoint'])})"

def step(P,rows,now,state,sender,ctrl,remind=None):
    out=[]; res=evaluate(P,rows,now,ctrl); skip=set(policy(P.get("plc","")).get("wa_skip",[]))
    for typ,(active,info) in res.items():
        if typ.startswith('_') or typ in MQTT_ONLY: continue
        if typ in skip:  # MQTT/PLC bit only, no WhatsApp; forget any earlier WA state silently
            state.pop(typ,None); continue
        s=state.get(typ,{"active":False})
        if active and not s["active"]: kind="new"
        elif active and (now-dt.datetime.fromisoformat(s["last_sent"])).total_seconds()>=REMIND_MIN*60: kind="remind"
        elif not active and s["active"]: kind="clear"
        else: continue
        key=f"{point_id(P)}:{typ}"; line=remind_line(P,ctrl,typ,info)[2:]
        if kind=="remind" and remind is not None:
            if not suppressed(key,now): remind.append(remind_line(P,ctrl,typ,info))
            s["last_sent"]=now.isoformat(); state[typ]=s; out.append((typ,kind,"(koonti)")); continue
        m=msg(P,ctrl,kind,typ,info,now); tgm=None; bkey=None
        if kind=="new":
            head="ℹ️" if typ in policy(P.get("plc","")).get("low_prio",[]) else "🚨"; tgm=f"{head} {line}"; bkey=key
        elif kind=="clear":
            st0=s.get("since"); dur=int((now-dt.datetime.fromisoformat(st0)).total_seconds()//60) if st0 else None
            # transient: cleared quickly and never reminded -> short note only, auto-acknowledged (ack/mute dropped below)
            transient=dur is not None and dur<TRANSIENT_MIN and s.get("last_sent")==s.get("_first_sent",s.get("last_sent"))
            lab=line.split(":",1)[0]
            tgm=f"ℹ️ {lab}: {typ} kävi hetken ({dur} min), ohi" if transient else f"✅ {lab}: {typ} ohi, nyt {num(round(info['v'],1)) if info.get('v') is not None else '?'} °C"
            clear_ack(key)
        if sender(m,tg=tgm,key=bkey):
            state[typ]={"active":active,"last_sent":now.isoformat(),"_first_sent":now.isoformat(),"since":(info.get("since") or now).isoformat() if active else None}
            out.append((typ,kind,m))
    return out

def payload(P,res,now,rows,ctrl,hb,disabled=False):
    B=P["bits"]
    alarm=sum(1<<B[k] for k,(a,_) in res.items() if a and k in B)
    word=alarm|ctrl_word(ctrl,P.get("plc"))|((1 if disabled else 0)<<DIS_BIT)
    js={"status":word,"alarm_bits":alarm,"active":[k for k in B if res.get(k,(False,))[0]],"bits":B,
        "controls":{"on":ctrl["on"],"heat":ctrl["heat"],"cool":ctrl["cool"],"setpoint":ctrl["setpoint"]},
        "layout":{"alarms":"0-6","ON":7,"HEAT":8,"COOL":9,"SP":"10-14","WA_DISABLED":15},
        "heartbeat":{"counter":hb},
        "alarms_disabled":bool(disabled),
        "alarms_disabled_until":ctrl["disabled_until"].astimezone(HEL).isoformat() if disabled and ctrl.get("disabled_until") else None,
        "temp":rows[-1][1] if rows else None,
        "last_reading":rows[-1][0].astimezone(HEL).isoformat() if rows else None,"checked":now.astimezone(HEL).isoformat(timespec="seconds"),
        "since":{k:(i.get("since").astimezone(HEL).isoformat() if i.get("since") else None) for k,(a,i) in res.items() if a and k in B}}
    return word,js
def mqtt_pub(topic,payload):
    r=subprocess.run(["mosquitto_pub","-h",MQTT_HOST,"-p",MQTT_PORT,"-r","-q","1","-t",topic,"-m",payload],capture_output=True,text=True,timeout=15)
    return None if r.returncode==0 else r.stderr.strip()[:200]
def publish(P,word,js):
    err=mqtt_pub(P["topic"]+"/json",json.dumps(js,ensure_ascii=False))
    if err: log(P,f"MQTT publish error {P['topic']}/json: {err}")
def log(P,s):
    with open(os.path.join(D,P["log"]),"a",encoding="utf-8") as f: f.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {s}\n")

WORDS={}; DISABLED={}
def run_point(pid,a,now,sender_factory,hb):
    P=POINTS[pid]; ctrl=controls(pid,P); STATE=os.path.join(D,P["state"])
    if a.sim:
        global _ASSUME_SB_OK; _ASSUME_SB_OK=True  # history has no SB Uptime log; assume healthy device
        s,e=[dt.datetime.fromisoformat(x).replace(tzinfo=HEL).astimezone(UTC) for x in a.sim]
        allr=query(P["var"],s-dt.timedelta(hours=24),e); state={}; t=s; n=0; ts=[r[0] for r in allr]
        while t<=e:
            rows=allr[bisect.bisect_left(ts,t-dt.timedelta(hours=24)):bisect.bisect_right(ts,t)]
            for typ,kind,m in step(P,rows,t,state,lambda m,**k:True,ctrl): print(f"[SIM {hel(t)}] {typ:8} {kind:6} | {m}"); n+=1
            t+=dt.timedelta(minutes=1)
        print(f"sim done: {n} would-be messages"); return 0
    try: rows=query(P["var"],now-dt.timedelta(hours=24),now)
    except Exception as ex: log(P,f"ERROR {ex}"); print(ex); return 1
    state=json.load(open(STATE)) if os.path.exists(STATE) else {}
    du=ctrl.get("disabled_until"); disabled=bool(du and now<du); expired=bool(du and now>=du)
    res=evaluate(P,rows,now,ctrl); word,js=payload(P,res,now,rows,ctrl,hb,disabled)
    if a.dry_run:
        print(f"[{pid}] now {hel(now)}, readings 24h: {len(rows)}, last {hel(rows[-1][0]) if rows else '-'} = {rows[-1][1] if rows else '-'} °C, controls {ctrl}")
        for k,(act,info) in res.items(): print(f"  {k:11} active={act}")
        print(f"  word {word} = 0b{word:016b}  json={json.dumps(js,ensure_ascii=False)[:160]}…")
        if not a.no_publish: publish(P,word,js); print("  published")
        st=json.loads(json.dumps(state))
        for typ,kind,m in step(P,rows,now,st,lambda m,**k:True,ctrl,REMIND_LINES): print(f"  WOULD SEND {typ} {kind}: {m}")
        return 0
    if expired:
        # auto re-enable: clear the DB flag, log the event, short WhatsApp notice, start alarm state fresh
        mysql(f"UPDATE alarm_point_controls SET alarms_disabled_until=NULL WHERE point_id='{pid}' AND alarms_disabled_until<=UTC_TIMESTAMP()")
        mysql("INSERT INTO alarm_events (point_id,alarm,bit,event,at,value,status_word) VALUES "
              f"('{pid}','Hälytykset palautettu automaattisesti',NULL,'control',UTC_TIMESTAMP(3),NULL,{word})")
        note=f"ℹ️ {P['name']}: hälytykset palautettu automaattisesti ({hel(now)})."
        ok=sender_factory(P)(note)
        state={k:v for k,v in state.items() if k.startswith('_')}
        log(P,f"alarms auto re-enabled (notice ok={ok})")
    if disabled:
        # WhatsApp disabled: evaluate and track normally, but only log the would-be messages
        quiet=lambda m,**k:(log(P,f"WA suppressed (WhatsApp alarms disabled) msg={m!r}"),True)[1]
        sent=step(P,rows,now,state,quiet,ctrl,[])
    else:
        sent=step(P,rows,now,state,sender_factory(P),ctrl,REMIND_LINES)
    publish(P,word,js); state['_status_word']=word; WORDS[pid]=word; DISABLED[pid]=disabled
    json.dump(state,open(STATE,"w"),indent=1)
    log(P,f"check ok readings={len(rows)} last={rows[-1][1] if rows else None} word={word}{' WA-DISABLED until '+hel(du) if disabled else ''} sent={[(t,k) for t,k,_ in sent]}")
    return 0

PID_POINTS={"F1_PID":dict(parent="ColdStorage1",name="Kylmäsäilytystila 1"),"T1_PID":dict(parent="Terrario1",name="Terrario 1")}
PID_WA_SKIP={"SATUROITUNUT"}
PID_STATE=os.path.join(D,"pid_alarm_state.json")
PID_LABEL={"EI_AUTO":"PID-säädin ei automaatilla","PID_VIKA":"PID-säätimen vika (Error)","ERRORBITS":"PID ErrorBits (kuittaa ErrorAck)",
           "OPCUA":"PID-data ei päivity (OPC UA / valvonta)","SATUROITUNUT":"PID-lähtö saturoitunut","LAHTO_NAN":"PID-lähtö virheellinen (NaN)","PID_LAHTO_JUMISSA":"PID-lähtö jumissa",
           "SENSOR_VIKA":"PID-mittauksen anturivika (Myko PV-syöttö)","INPUT_STALE":"PID-mittaus ei päivity PLC:lle (Myko PV-syöttö)",
           "ANTURIVIKA_ALASAJO":"P1 ANTURIVIKA – piste ajettu alas (ON pois, lämmitys+jäähdytys seis). Käynnistä uudelleen käsin"}
STATE_TXT={0:"ei aktiivinen",1:"esiviritys",2:"hienoviritys",3:"automaatti",4:"käsiajo",5:"korvaava lähtö"}
def run_pid(a,now,sender_factory):
    st=json.load(open(PID_STATE)) if os.path.exists(PID_STATE) else {}
    for pid,PP in PID_POINTS.items():
        if a.point and a.point!=PP["parent"]: continue
        P=dict(POINTS[PP["parent"]]); P["name"]=PP["name"]+" PID"
        out=mysql("SELECT COALESCE(last_active,'[]'),COALESCE(last_payload,'{}'),COALESCE(DATE_FORMAT(last_message_at,'%Y-%m-%d %H:%i:%s'),'') "
                  f"FROM alarm_points WHERE id='{pid}' AND enabled=1").strip("\n")
        if not out: continue
        la,lp,lm=out.split("\t"); active=set(json.loads(la)); pl=json.loads(lp); pv=pl.get("pid") or {}
        lmt=dt.datetime.strptime(lm,"%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC) if lm else None
        if not lmt or (now-lmt).total_seconds()>300: active.add("OPCUA")   # backend evaluator itself silent
        ctrl=controls(PP["parent"],POINTS[PP["parent"]]); du=ctrl.get("disabled_until"); muted=bool(du and now<du)
        S=st.setdefault(pid,{}); eb=int(pv.get("ErrBits") or 0)
        sender=(lambda m,**k:(log(P,f"WA suppressed (WhatsApp alarms disabled) msg={m!r}"),True)[1]) if muted else sender_factory(P)
        if a.dry_run: sender=lambda m,**k:(print("  WOULD SEND",m),True)[1]
        cur=f"tila {STATE_TXT.get(pv.get('State'),pv.get('State'))}, ErrorBits 16#{eb:04X}, lähtö {round(pv.get('OutSum') or 0)} % ({hel(now)})"
        for k in PID_LABEL:
            if k in PID_WA_SKIP: continue
            s0=S.get(k,{"active":False}); on=k in active
            newbits=k=="ERRORBITS" and on and s0.get("active") and (eb & ~int(s0.get("errbits",0)))
            if on and (not s0["active"] or newbits): kind="new"
            elif on and (now-dt.datetime.fromisoformat(s0["last_sent"])).total_seconds()>=REMIND_MIN*60: kind="remind"
            elif not on and s0["active"]: kind="clear"
            else: continue
            pkey=f"{pid}:{k}"
            if kind=="remind" and not muted:
                if not suppressed(pkey,now): REMIND_LINES.append(f"• {PLC_KEYS[PP['parent']]} PID: {PID_LABEL[k].split(' – ')[0]}")
                if not a.dry_run: S[k]["last_sent"]=now.isoformat()
                continue
            head={"new":"🚨 HÄLYTYS","remind":"⏰ MUISTUTUS, hälytys jatkuu","clear":"✅ PALAUTUNUT"}[kind]
            m=f"{head}: {PP['name']} – {PID_LABEL[k]}{' ohi' if kind=='clear' else ''}. {cur}"
            short=f"{PLC_KEYS[PP['parent']]} PID: {PID_LABEL[k].split(' – ')[0]}"
            if kind=="clear": clear_ack(pkey)
            if sender(m,tg=("✅ "+short+" ohi") if kind=="clear" else ("🚨 "+short),key=pkey if kind=="new" else None) and not a.dry_run:
                S[k]={"active":on,"last_sent":now.isoformat(),"errbits":eb if on else 0}; log(P,f"PID {pid} {k} {kind} sent")
    if not a.dry_run: json.dump(st,open(PID_STATE,"w"),indent=1)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--no-publish",action="store_true")
    ap.add_argument("--no-wa",action="store_true",help="live run, but WhatsApp messages are only logged (testing)")
    ap.add_argument("--sim",nargs=2,metavar=("START","END")); ap.add_argument("--point",choices=list(POINTS)); a=ap.parse_args()
    now=dt.datetime.now(UTC).replace(microsecond=0)
    def sender_factory(P):
        if a.no_wa:
            return lambda m,**k:(log(P,f"WA suppressed (--no-wa) msg={m!r}"),True)[1]
        sys.path.insert(0,D); from wa_alert import send; import tg_alert
        ch=channels()
        def sender(m,tg=None,key=None):
            """Telegram (primary, one line + buttons) and WhatsApp (backup, as before); ok if any channel delivered."""
            ok=False
            if ch["telegram"]:
                try: okt=tg_alert.send(tg or m,buttons_key=key,chat_ids_=tg_alert.chat_ids(setting("telegram_chat_ids",[]) or []))
                except Exception as ex: okt=False; log(P,f"telegram ERROR {type(ex).__name__}")
                log(P,f"telegram ok={okt} msg={(tg or m)!r}"); ok|=okt
            if ch["whatsapp"]:
                okw,status,body=send(m,bypass_rate=True,tag="ALARM "); log(P,f"send status={status} ok={okw} msg={m!r}"); ok|=okw
            return ok
        return sender
    # Heartbeat: counter +1 per live run (wraps at 65535); published only as the "Heartbeat" key.
    hb_prev=json.load(open(HB_STATE)).get("counter",0) if os.path.exists(HB_STATE) else 0
    live=not a.dry_run and not a.sim
    hb=(hb_prev+1)%65536 if live else hb_prev
    rc=0
    for pid in ([a.point] if a.point else list(POINTS)):
        try: rc|=run_point(pid,a,now,sender_factory,hb)
        except Exception as ex: log(POINTS[pid],f"ERROR {ex}"); print(pid,ex); rc=1
    if not a.sim:
        try: run_pid(a,now,sender_factory)
        except Exception as ex: log(POINTS["ColdStorage1"],f"PID alarm ERROR {ex}"); print("pid",ex); rc=1
    if REMIND_LINES and not a.sim:
        m=f"⏰ Aktiiviset hälytykset ({hel(now)}):\n"+"\n".join(REMIND_LINES)
        if a.dry_run: print("WOULD SEND REMINDER:\n"+m)
        else:
            try: sender_factory(POINTS["ColdStorage1"])(m)
            except Exception as ex: log(POINTS["ColdStorage1"],f"reminder send ERROR {ex}")
    if live:
        json.dump({"counter":hb,"at":now.isoformat()},open(HB_STATE,"w"))
        if not a.point:
            # a point whose run failed keeps its previous word from state (0 if none)
            def prev(pid):
                f=os.path.join(D,POINTS[pid]["state"])
                return WORDS.get(pid, json.load(open(f)).get("_status_word",0) if os.path.exists(f) else 0)
            plc={"Heartbeat":hb}  # Heartbeat MUST be the first key (PLC parser)
            for pid,key in PLC_KEYS.items(): plc[key]=int(prev(pid))
            err=mqtt_pub(PLC_TOPIC,json.dumps(plc,separators=(",",":")))
            if err: log(POINTS["ColdStorage1"],f"MQTT publish error {PLC_TOPIC}: {err}")
    return rc
if __name__=="__main__": sys.exit(main())
