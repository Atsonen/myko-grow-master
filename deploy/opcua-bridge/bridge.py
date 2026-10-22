#!/usr/bin/env python3
"""OPC UA -> MQTT bridge. Reads config topics; whitelisted writes from config `commands` (MQTT -> OPC UA)."""
import asyncio, json, logging, time, sys, os
from logging.handlers import RotatingFileHandler
import yaml, paho.mqtt.client as mqtt
from asyncua import Client, ua

BASE = os.path.dirname(os.path.abspath(__file__))
cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
log = logging.getLogger("bridge"); log.setLevel(logging.INFO)
h = RotatingFileHandler(os.path.join(BASE, "bridge.log"), maxBytes=2_000_000, backupCount=3)
h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s")); log.addHandler(h)
log.addHandler(logging.StreamHandler(sys.stdout))
logging.getLogger("asyncua").setLevel(logging.WARNING)

m = cfg["mqtt"]; pub = cfg.get("publish", {})
mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=m.get("client_id", "opcua-bridge"))
cmds = cfg.get("commands") or {}
cmdq = None; loop = None
def on_connect(cl, ud, fl, rc, props=None):
    for t in cmds: cl.subscribe(t, qos=1)
def on_message(cl, ud, msg):
    if loop and cmdq is not None: loop.call_soon_threadsafe(cmdq.put_nowait, (msg.topic, msg.payload))
mq.on_connect = on_connect; mq.on_message = on_message
mq.reconnect_delay_set(1, 30); mq.connect_async(m["host"], m.get("port", 1883)); mq.loop_start()

values = {t: {} for t in cfg["topics"]}
node2 = {}  # nodeid str -> (topic, key)
for t, mp in cfg["topics"].items():
    for k, nid in mp.items(): node2[nid] = (t, k)
last_pub = {t: 0.0 for t in values}; dirty = set()

def clean(v):
    if isinstance(v, float): return round(v, 3)
    if isinstance(v, (int, bool, str)) or v is None: return v
    return str(v)

def publish(t):
    d = {k: v for k, v in values[t].items() if v is not None}
    if not d: return
    mq.publish(t, json.dumps(d, separators=(",", ":")), qos=0, retain=m.get("retain", False))
    last_pub[t] = time.time(); dirty.discard(t)

class Handler:
    def datachange_notification(self, node, val, data):
        tk = node2.get(node.nodeid.to_string())
        if tk: values[tk[0]][tk[1]] = clean(val); dirty.add(tk[0])

async def pump():
    mi, hb = pub.get("min_interval_s", 1.0), pub.get("heartbeat_s", 60)
    while True:
        now = time.time()
        for t in values:
            if (t in dirty and now - last_pub[t] >= mi) or (hb and now - last_pub[t] >= hb): publish(t)
        await asyncio.sleep(0.2)

async def session():
    o = cfg["opcua"]; c = Client(o["endpoint"], timeout=10)
    if o.get("username"): c.set_user(o["username"]); c.set_password(o.get("password") or "")
    if o.get("security") and o["security"] != "None": await c.set_security_string(o["security"])
    async with c:
        log.info("connected %s", o["endpoint"])
        sub = await c.create_subscription(o.get("publishing_interval_ms", 1000), Handler())
        nodes = [c.get_node(n) for n in node2]
        res = await sub.subscribe_data_change(nodes)
        for n, r in zip(node2, res if isinstance(res, list) else [res]):
            if not isinstance(r, int): log.warning("subscribe failed %s: %s", n, r)
        last_chk = time.time()
        while True:
            try: item = await asyncio.wait_for(cmdq.get(), 1.0)
            except asyncio.TimeoutError: item = None
            if item: await handle_cmd(c, *item)
            if time.time() - last_chk > 5: await c.check_connection(); last_chk = time.time()

VT = {"Float": ua.VariantType.Float, "Boolean": ua.VariantType.Boolean, "Int16": ua.VariantType.Int16}
def ack(topic, d):
    mq.publish(topic + "/ack", json.dumps(d, separators=(",", ":")), qos=1, retain=False)

async def handle_cmd(c, topic, payload):
    wl = cmds.get(topic, {})
    try: req = json.loads(payload)
    except Exception: log.warning("CMD %s bad json %r", topic, payload[:200]); return
    if not isinstance(req, dict): return
    cid = req.pop("id", None); src = req.pop("by", None); res = {}
    # ModeActivate must follow Mode in the same message
    for k in sorted(req, key=lambda k: k == "ModeActivate"):
        v = req[k]; w = wl.get(k)
        if not w: res[k] = "rejected: not whitelisted"; log.warning("CMD reject %s %s=%r (not whitelisted)", topic, k, v); continue
        try:
            t = w["type"]
            if t == "Boolean":
                if not isinstance(v, bool): raise ValueError("bool expected")
            elif t == "Int16":
                if not isinstance(v, int) or isinstance(v, bool) or v not in w.get("allowed", [v]): raise ValueError("value not allowed")
            else:
                if not isinstance(v, (int, float)) or isinstance(v, bool) or v != v: raise ValueError("number expected")
                v = float(v); lo, hi = w.get("min"), w.get("max")
                if w.get("clamp_to"):
                    st = values.get(w.get("state_topic"), {}); lo, hi = st.get(w["clamp_to"][0]), st.get(w["clamp_to"][1])
                    if lo is None or hi is None: raise ValueError("limits unknown")
                if lo is not None and v < lo: v = float(lo)
                if hi is not None and v > hi: v = float(hi)
            node = c.get_node(w["node"])
            if w.get("pulse"):
                await node.write_value(ua.DataValue(ua.Variant(True, VT[t]))); await asyncio.sleep(0.5)
                await node.write_value(ua.DataValue(ua.Variant(False, VT[t]))); res[k] = "ok (pulse)"
            else:
                await node.write_value(ua.DataValue(ua.Variant(v, VT[t]))); res[k] = "ok"
            log.info("CMD write %s %s=%r node=%s by=%s id=%s", topic, k, v, w["node"], src, cid)
            res[k] = {"result": res[k], "value": v}
        except Exception as e:
            res[k] = f"error: {e}"; log.error("CMD fail %s %s=%r: %r", topic, k, v, e)
    ack(topic, {"id": cid, "ts": time.time(), "results": res})

async def main():
    global cmdq, loop
    loop = asyncio.get_running_loop(); cmdq = asyncio.Queue()
    asyncio.create_task(pump()); delay = 1
    while True:
        t0 = time.time()
        try: await session()
        except asyncio.CancelledError: raise
        except Exception as e: log.error("opcua error: %r", e)
        if time.time() - t0 > 60: delay = 1
        log.info("reconnect in %ss", delay); await asyncio.sleep(delay); delay = min(delay * 2, 60)

if __name__ == "__main__": asyncio.run(main())
