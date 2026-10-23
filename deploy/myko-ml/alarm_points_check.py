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
SATUROITUNUT is log-only (no WhatsApp)."""
import os, sys, json, bisect, subprocess, argparse, datetime as dt
from zoneinfo import ZoneInfo
D=os.path.dirname(os.path.abspath(__file__))
HEL=ZoneInfo("Europe/Helsinki"); UTC=dt.timezone.utc
REMIND_MIN=60
FLAT_MQTT_MIN=15; FLAT_WA_MIN=120  # FLATLINE: MQTT bit at 15 min; WhatsApp (FLATLINE_WA) at 120 min
MQTT_ONLY={"FLATLINE"}
MQTT_HOST,MQTT_PORT="192.168.1.51","1883"
CTRL_BITS={"ON":7,"HEAT":8,"COOL":9}; SP_SHIFT=10; SP_MASK=0x1F; DIS_BIT=15
HB_STATE=os.path.join(D,"heartbeat_state.json")
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
    sp=c["setpoint"]
    return {
     "CRIT":("KRIITTINEN: yli 14 °C",lambda v:v>14,3),
     "HIGH":(f"KORKEA: yli {num(sp+c['high_delta'])} °C",lambda v:v>sp+c["high_delta"],c["high_min"]),
     "WARN":warn_rule(c,lambda sp,d:f"VAROITUS: poikkeama asetusarvosta {num(sp)} °C yli {num(d)} °C"),
     "LOW":(f"MATALA: alle {num(sp-c['low_delta'])} °C",lambda v:v<sp-c["low_delta"],c["low_min"]),
     "FREEZE":("JÄÄTYMINEN: 0 °C tai alle",lambda v:v<=0,0)}
def t1_rules(c):
    sp=c["setpoint"]
    return {
     "CRIT":("KRIITTINEN: yli 30 °C",lambda v:v>30,3),
     "HIGH":(f"KORKEA: yli {num(sp+c['high_delta'])} °C (asetusarvo {num(sp)} °C)",lambda v:v>sp+c["high_delta"],c["high_min"]),
     "WARN":warn_rule(c,lambda sp,d:f"VAROITUS: poikkeama asetusarvosta {num(sp)} °C yli {num(d)} °C"),
     "LOW":(f"MATALA: alle {num(sp-c['low_delta'])} °C (asetusarvo {num(sp)} °C)",lambda v:v<sp-c["low_delta"],c["low_min"]),
     "COLD":("KYLMÄ: alle 15 °C",lambda v:v<15,3)}

POINTS={
 "ColdStorage1":dict(name="Kylmäsäilytystila 1",var="dl02",topic="Myko/Alarms/ColdStorage1",rules=f1_rules,
   bits={"WARN":0,"HIGH":1,"CRIT":2,"LOW":3,"FREEZE":4,"FLATLINE":5,"STALE":6},instant={"FREEZE"},
   state="cold_alarm_state.json",log="cold_alarm.log",plc="F1",
   defaults=dict(on=1,heat=0,cool=0,setpoint=8,warn_delta=1.0,warn_min=30,warn_both=0,high_delta=3.0,high_min=10,low_delta=3.0,low_min=3,disabled_until=None)),
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
    st=None
    for t,v in reversed(rows):
        if v==last_v: st=t
        else: break
    res["FLATLINE"]=(st is not None and (last_t-st).total_seconds()>=FLAT_MQTT_MIN*60,{"since":st,"v":last_v})
    res["FLATLINE_WA"]=(st is not None and (last_t-st).total_seconds()>=FLAT_WA_MIN*60,{"since":st,"v":last_v})
    if res["STALE"][0]:
        for k in ("FLATLINE","FLATLINE_WA"): res[k]=(False,res[k][1])
    return res

def msg(P,ctrl,kind,typ,info,now):
    NAME=P["name"]; v=info.get("v"); cur=f"Nyt {v:.1f} °C ({hel(now)})" if v is not None else f"({hel(now)})"
    since=f"alkaen {hel(info['since'])}" if info.get("since") else ""
    if typ=="STALE": d=f"ei uusia mittauksia {since.replace('alkaen','viimeisin')}".strip(); lab="YHTEYSVIKA: ei dataa 10 min"; cur=f"Viimeisin arvo {v:.1f} °C" if v is not None else ""
    elif typ in ("FLATLINE","FLATLINE_WA"): lab=f"ANTURIVIKA?: arvo ei muutu {FLAT_WA_MIN} min"; d=f"sama arvo {since}"
    else:
        lab=P["rules"](ctrl)[typ][0]; dur=int((now-info['since']).total_seconds()//60) if info.get("since") else 0
        low=typ in ("LOW","FREEZE","COLD") or (typ=="WARN" and v is not None and v<ctrl["setpoint"])
        ext=("min",info.get("min",v)) if low else ("max",info.get("max",v)); d=f"{dur} min {since}, {ext[0]} {ext[1]:.1f} °C"
    head={"new":"🚨 HÄLYTYS","remind":"⏰ MUISTUTUS, hälytys jatkuu","clear":"✅ PALAUTUNUT"}[kind]
    if kind=="clear": return f"{head}: {NAME} – {lab.split(':')[0]} ohi. {cur}"
    return f"{head}: {NAME} – {lab}. {d}. {cur}"

def step(P,rows,now,state,sender,ctrl):
    out=[]; res=evaluate(P,rows,now,ctrl)
    for typ,(active,info) in res.items():
        if typ.startswith('_') or typ in MQTT_ONLY: continue
        s=state.get(typ,{"active":False})
        if active and not s["active"]: kind="new"
        elif active and (now-dt.datetime.fromisoformat(s["last_sent"])).total_seconds()>=REMIND_MIN*60: kind="remind"
        elif not active and s["active"]: kind="clear"
        else: continue
        m=msg(P,ctrl,kind,typ,info,now)
        if sender(m):
            state[typ]={"active":active,"last_sent":now.isoformat(),"since":(info.get("since") or now).isoformat() if active else None}
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
        s,e=[dt.datetime.fromisoformat(x).replace(tzinfo=HEL).astimezone(UTC) for x in a.sim]
        allr=query(P["var"],s-dt.timedelta(hours=24),e); state={}; t=s; n=0; ts=[r[0] for r in allr]
        while t<=e:
            rows=allr[bisect.bisect_left(ts,t-dt.timedelta(hours=24)):bisect.bisect_right(ts,t)]
            for typ,kind,m in step(P,rows,t,state,lambda m:True,ctrl): print(f"[SIM {hel(t)}] {typ:8} {kind:6} | {m}"); n+=1
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
        for typ,kind,m in step(P,rows,now,st,lambda m:True,ctrl): print(f"  WOULD SEND {typ} {kind}: {m}")
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
        quiet=lambda m:(log(P,f"WA suppressed (WhatsApp alarms disabled) msg={m!r}"),True)[1]
        sent=step(P,rows,now,state,quiet,ctrl)
    else:
        sent=step(P,rows,now,state,sender_factory(P),ctrl)
    publish(P,word,js); state['_status_word']=word; WORDS[pid]=word; DISABLED[pid]=disabled
    json.dump(state,open(STATE,"w"),indent=1)
    log(P,f"check ok readings={len(rows)} last={rows[-1][1] if rows else None} word={word}{' WA-DISABLED until '+hel(du) if disabled else ''} sent={[(t,k) for t,k,_ in sent]}")
    return 0

PID_POINTS={"F1_PID":dict(parent="ColdStorage1",name="Kylmäsäilytystila 1"),"T1_PID":dict(parent="Terrario1",name="Terrario 1")}
PID_WA_SKIP={"SATUROITUNUT"}
PID_STATE=os.path.join(D,"pid_alarm_state.json")
PID_LABEL={"EI_AUTO":"PID-säädin ei automaatilla","PID_VIKA":"PID-säätimen vika (Error)","ERRORBITS":"PID ErrorBits (kuittaa ErrorAck)",
           "OPCUA":"PID-data ei päivity (OPC UA / valvonta)","SATUROITUNUT":"PID-lähtö saturoitunut",
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
        sender=(lambda m:(log(P,f"WA suppressed (WhatsApp alarms disabled) msg={m!r}"),True)[1]) if muted else sender_factory(P)
        if a.dry_run: sender=lambda m:(print("  WOULD SEND",m),True)[1]
        cur=f"tila {STATE_TXT.get(pv.get('State'),pv.get('State'))}, ErrorBits 16#{eb:04X}, lähtö {round(pv.get('OutSum') or 0)} % ({hel(now)})"
        for k in PID_LABEL:
            if k in PID_WA_SKIP: continue
            s0=S.get(k,{"active":False}); on=k in active
            newbits=k=="ERRORBITS" and on and s0.get("active") and (eb & ~int(s0.get("errbits",0)))
            if on and (not s0["active"] or newbits): kind="new"
            elif on and (now-dt.datetime.fromisoformat(s0["last_sent"])).total_seconds()>=REMIND_MIN*60: kind="remind"
            elif not on and s0["active"]: kind="clear"
            else: continue
            head={"new":"🚨 HÄLYTYS","remind":"⏰ MUISTUTUS, hälytys jatkuu","clear":"✅ PALAUTUNUT"}[kind]
            m=f"{head}: {PP['name']} – {PID_LABEL[k]}{' ohi' if kind=='clear' else ''}. {cur}"
            if sender(m) and not a.dry_run:
                S[k]={"active":on,"last_sent":now.isoformat(),"errbits":eb if on else 0}; log(P,f"PID {pid} {k} {kind} sent")
    if not a.dry_run: json.dump(st,open(PID_STATE,"w"),indent=1)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--no-publish",action="store_true")
    ap.add_argument("--no-wa",action="store_true",help="live run, but WhatsApp messages are only logged (testing)")
    ap.add_argument("--sim",nargs=2,metavar=("START","END")); ap.add_argument("--point",choices=list(POINTS)); a=ap.parse_args()
    now=dt.datetime.now(UTC).replace(microsecond=0)
    def sender_factory(P):
        if a.no_wa:
            return lambda m:(log(P,f"WA suppressed (--no-wa) msg={m!r}"),True)[1]
        sys.path.insert(0,D); from wa_alert import send
        def sender(m):
            ok,status,body=send(m,bypass_rate=True,tag="ALARM "); log(P,f"send status={status} ok={ok} msg={m!r}"); return ok
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
