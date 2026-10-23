#!/usr/bin/env python3
"""OPC UA -> MQTT bridge for PLC_2 (S7-1215C).
Reads config `topics` and every PID_Temp instance in `pids` (-> Sensors/PLC_2/<key>_PID) and executes
whitelisted writes from Myko/Cmd/<key>_PID (ack on Myko/Cmd/<key>_PID/ack). Nodes are resolved by browse
path at every connect (see config.yaml), so interface renames / namespace index changes do not break it."""
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
# topic -> {key: address}
TOPICS = {t: dict(mp) for t, mp in (cfg.get("topics") or {}).items()}
PIDS = cfg.get("pids") or {}
for k, p in PIDS.items():
    TOPICS[f"Sensors/PLC_2/{k}_PID"] = {sk: f"@*/{p['instance']}/{path}" for sk, path in (cfg.get("pid_nodes") or {}).items()}
CMD_TOPICS = {f"Myko/Cmd/{k}_PID": k for k in PIDS}
WL = cfg.get("pid_commands") or {}
WCOUNT = {}

mq = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=m.get("client_id", "opcua-bridge"))
cmdq = None; loop = None
def on_connect(cl, ud, fl, rc, props=None):
    for t in CMD_TOPICS: cl.subscribe(t, qos=1)
def on_message(cl, ud, msg):
    if loop and cmdq is not None: loop.call_soon_threadsafe(cmdq.put_nowait, (msg.topic, msg.payload))
mq.on_connect = on_connect; mq.on_message = on_message
mq.reconnect_delay_set(1, 30); mq.connect_async(m["host"], m.get("port", 1883)); mq.loop_start()

values = {t: {} for t in TOPICS}
node2 = {}  # nodeid str -> (topic, key), rebuilt per session
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

class Resolver:
    """Browse-name path resolution under ServerInterfaces, cached per session."""
    def __init__(self, c): self.c = c; self.cache = {}; self.ifaces = None
    async def children(self, node):
        key = node.nodeid.to_string()
        if key not in self.cache:
            self.cache[key] = {(await ch.read_browse_name()).Name: ch for ch in await node.get_children()}
        return self.cache[key]
    async def interfaces(self):
        if self.ifaces is None:
            r = cfg["opcua"].get("interfaces_root") or {}
            ns = await self.c.get_namespace_index(r.get("uri", "http://www.siemens.com/simatic-s7-opcua"))
            root = self.c.get_node(ua.NodeId(r.get("id", "ServerInterfaces"), ns))
            self.ifaces = await self.children(root)
            log.info("server interfaces: %s", {n: v.nodeid.to_string() for n, v in self.ifaces.items()})
        return self.ifaces
    async def resolve(self, addr):
        if not addr.startswith("@"): return self.c.get_node(addr)
        segs = addr[1:].split("/"); ifs = await self.interfaces()
        if segs[0] == "*":
            node = None
            for iface in ifs.values():
                if segs[1] in await self.children(iface): node = iface; break
            if node is None: raise KeyError(f"{segs[1]} not found in any interface")
            segs = segs[1:]
        else:
            node = ifs[segs[0]]; segs = segs[1:]
        for s in segs:
            ch = await self.children(node)
            if s not in ch: raise KeyError(f"{s} not found ({addr})")
            node = ch[s]
        return node

async def session():
    o = cfg["opcua"]; c = Client(o["endpoint"], timeout=10)
    if o.get("username"): c.set_user(o["username"]); c.set_password(o.get("password") or "")
    if o.get("security") and o["security"] != "None": await c.set_security_string(o["security"])
    async with c:
        log.info("connected %s", o["endpoint"])
        R = Resolver(c); node2.clear(); nodes = []
        for t, mp in TOPICS.items():
            ok = 0
            for k, addr in mp.items():
                try:
                    n = await R.resolve(addr); node2[n.nodeid.to_string()] = (t, k); nodes.append(n); ok += 1
                except Exception as e: log.warning("resolve failed %s %s: %s", t, k, e)
            log.info("topic %s: %d/%d nodes resolved", t, ok, len(mp))
        cmd_nodes = {}  # pid key -> {cmd: node}
        for k, p in PIDS.items():
            cmd_nodes[k] = {}
            for cn, w in WL.items():
                try: cmd_nodes[k][cn] = await R.resolve(f"@*/{p['instance']}/{w['path']}")
                except Exception as e: log.warning("resolve cmd %s.%s failed: %s", k, cn, e)
        sub = await c.create_subscription(o.get("publishing_interval_ms", 1000), Handler())
        res = await sub.subscribe_data_change(nodes)
        for n, r in zip(nodes, res if isinstance(res, list) else [res]):
            if not isinstance(r, int): log.warning("subscribe failed %s: %s", n, r)
        last_chk = time.time()
        while True:
            try: item = await asyncio.wait_for(cmdq.get(), 1.0)
            except asyncio.TimeoutError: item = None
            if item: await handle_cmd(cmd_nodes, *item)
            if time.time() - last_chk > 5: await c.check_connection(); last_chk = time.time()

VT = {"Float": ua.VariantType.Float, "Boolean": ua.VariantType.Boolean, "Int16": ua.VariantType.Int16}
def ack(topic, d):
    mq.publish(topic + "/ack", json.dumps(d, separators=(",", ":")), qos=1, retain=False)

async def handle_cmd(cmd_nodes, topic, payload):
    pk = CMD_TOPICS.get(topic)
    if not pk: return
    try: req = json.loads(payload)
    except Exception: log.warning("CMD %s bad json %r", topic, payload[:200]); return
    if not isinstance(req, dict): return
    cid = req.pop("id", None); src = req.pop("by", None); res = {}
    state = values.get(f"Sensors/PLC_2/{pk}_PID", {})
    for k in sorted(req, key=lambda k: k == "ModeActivate"):  # ModeActivate after Mode
        v = req[k]; w = WL.get(k); node = cmd_nodes.get(pk, {}).get(k)
        if not w or node is None:
            res[k] = "rejected: not whitelisted"; log.warning("CMD reject %s %s=%r (not whitelisted/resolved)", topic, k, v); continue
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
                    lo, hi = state.get(w["clamp_to"][0]), state.get(w["clamp_to"][1])
                    fb = (PIDS.get(pk) or {}).get("limits")  # static fallback when Config limits are not OPC UA readable
                    if (lo is None or hi is None) and fb: lo, hi = fb
                    if lo is None or hi is None: raise ValueError("limits unknown")
                if lo is not None and v < lo: v = float(lo)
                if hi is not None and v > hi: v = float(hi)
            if w.get("pulse"):
                await node.write_value(ua.DataValue(ua.Variant(True, VT[t]))); await asyncio.sleep(0.5)
                await node.write_value(ua.DataValue(ua.Variant(False, VT[t]))); r = "ok (pulse)"
            else:
                await node.write_value(ua.DataValue(ua.Variant(v, VT[t]))); r = "ok"
            n_ = WCOUNT[(pk, k)] = WCOUNT.get((pk, k), 0) + 1
            if n_ % w.get("log_every", 1) == 1 or w.get("log_every", 1) == 1:  # high-rate keys (Input) logged every Nth write
                log.info("CMD write %s %s=%r node=%s by=%s id=%s (n=%d)", topic, k, v, node.nodeid.to_string(), src, cid, n_)
            res[k] = {"result": r, "value": v}
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
