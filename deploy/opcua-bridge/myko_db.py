#!/usr/bin/env python3
"""DB_Myko access (Myko -> PLC), Read/Write services only, never subscriptions.
  myko_db.py --detect        browse for DB_Myko under ServerInterfaces; print {"found":bool,"iface":..,"fields":{path:type}}
  myko_db.py --daemon        persistent session; stdin JSON lines {"id":n,"write":{"Common/Hb_Counter":5,...}}
                             -> stdout {"id":n,"results":{path:{"ok":bool,"read":v}}}. Reconnects on error.
Only paths matching ALLOWED are written; everything else is refused."""
import asyncio, json, sys, os, re, yaml
from asyncua import Client, ua
CFG = yaml.safe_load(open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "config.yaml")))
DB = "DB_Myko"
ALLOWED = re.compile(r"^(Common/(Hb_Counter|Wd_TimeoutS|Cmd_SensorPwrReset|Pwr_OffS|Pwr_LockoutS)"
                     r"|[A-Za-z0-9_]+/(Safe_Output|Safe_OutputSet|Safe_Source|PV_FreezeS))$")
VT = {ua.ObjectIds.Boolean: ua.VariantType.Boolean, ua.ObjectIds.Int16: ua.VariantType.Int16, ua.ObjectIds.UInt16: ua.VariantType.UInt16,
      ua.ObjectIds.Int32: ua.VariantType.Int32, ua.ObjectIds.UInt32: ua.VariantType.UInt32, ua.ObjectIds.Float: ua.VariantType.Float,
      ua.ObjectIds.Double: ua.VariantType.Double, ua.ObjectIds.Byte: ua.VariantType.Byte}

async def find_db(c):
    o = CFG["opcua"]; ns = await c.get_namespace_index(o["interfaces_root"]["uri"])
    root = c.get_node(ua.NodeId(o["interfaces_root"]["id"], ns))
    for iface in await root.get_children():
        for ch in await iface.get_children():
            if (await ch.read_browse_name()).Name == DB: return (await iface.read_browse_name()).Name, ch
    return None, None

async def leaves(node, path="", out=None, depth=0):
    out = {} if out is None else out
    for ch in await node.get_children():
        name = (await ch.read_browse_name()).Name; p = f"{path}/{name}" if path else name
        kids = await ch.get_children()
        if await ch.read_node_class() == ua.NodeClass.Variable and not kids: out[p] = ch
        elif depth < 3: await leaves(ch, p, out, depth + 1)
    return out

async def detect():
    async with Client(CFG["opcua"]["endpoint"], timeout=10) as c:
        iface, db = await find_db(c)
        if db is None: print(json.dumps({"found": False})); return
        f = await leaves(db); types = {}
        for p, n in f.items():
            dt = (await n.read_data_type()).Identifier
            types[p] = VT.get(dt, ua.VariantType.Null).name
        print(json.dumps({"found": True, "iface": iface, "fields": types}))

async def daemon():
    loop = asyncio.get_event_loop(); rd = asyncio.StreamReader(); await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(rd), sys.stdin)
    while True:
        try:
            async with Client(CFG["opcua"]["endpoint"], timeout=10) as c:
                _, db = await find_db(c)
                if db is None: print(json.dumps({"error": "DB_Myko not found"}), flush=True); await asyncio.sleep(60); continue
                f = await leaves(db); dts = {p: VT.get((await n.read_data_type()).Identifier) for p, n in f.items()}
                print(json.dumps({"ready": True, "fields": sorted(f)}), flush=True)
                while True:
                    line = await rd.readline()
                    if not line: return
                    m = json.loads(line); res = {}
                    for p, v in (m.get("write") or {}).items():
                        if not ALLOWED.match(p) or p not in f or dts[p] is None: res[p] = {"ok": False, "error": "refused/unknown"}; continue
                        t = dts[p]; val = bool(v) if t == ua.VariantType.Boolean else (float(v) if t in (ua.VariantType.Float, ua.VariantType.Double) else int(v))
                        await f[p].write_value(ua.DataValue(ua.Variant(val, t)))
                        res[p] = {"ok": True}
                    for p in m.get("read") or []:
                        if p in f: res.setdefault(p, {})["read"] = await f[p].read_value()
                    print(json.dumps({"id": m.get("id"), "results": res}, default=str), flush=True)
        except Exception as e:
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True); await asyncio.sleep(10)

asyncio.run(detect() if "--detect" in sys.argv else daemon())
