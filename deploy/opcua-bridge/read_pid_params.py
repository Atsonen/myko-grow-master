#!/usr/bin/env python3
"""Read-only one-shot: dump PID_Temp tuning parameters for one instance as JSON.
Usage: read_pid_params.py <InstanceName>                  read-only dump (Read service, no subscription)
       read_pid_params.py <InstanceName> --write '<json>'   write whitelisted Retain.CtrlParams Reals, then read back
       json = {"Heat/Gain": 1.2, ...}. Only WRITE_OK members; anything else is refused before connecting."""
import asyncio, json, sys, yaml, os
from asyncua import Client, ua
CFG = yaml.safe_load(open(os.path.join(os.path.dirname(os.path.realpath(__file__)), "config.yaml")))
WANT = ("Retain", "Config", "CtrlParams", "Heat", "Cool", "Output", "PwmLimit", "InputPerOn")  # subtrees to walk
async def walk(node, path, out, depth):
    for ch in await node.get_children():
        name = (await ch.read_browse_name()).Name; p = f"{path}/{name}" if path else name
        nc = await ch.read_node_class()
        if nc == ua.NodeClass.Variable:
            kids = await ch.get_children()
            if not kids:
                out.append((p, ch)); continue
        if depth < 5: await walk(ch, p, out, depth + 1)
WRITE_OK = {f"{s}/{m}" for s in ("Heat", "Cool") for m in ("Gain", "Ti", "Td", "TdFiltRatio", "PWeighting", "DWeighting", "Cycle", "DeadZone", "ControlZone")}
async def child(node, name):
    for ch in await node.get_children():
        if (await ch.read_browse_name()).Name == name: return ch
    raise KeyError(name)
async def write(c, node, req):
    # Siemens: in Automatic/Manual mode do NOT write Retain.CtrlParams directly. Copy the full active set into
    # CtrlParamsBackUp, override the requested members, then LoadBackUp := TRUE (PID_Temp copies the backup into
    # Retain.CtrlParams and resets LoadBackUp). Then read Retain.CtrlParams back.
    ret = await child(await child(node, "Retain"), "CtrlParams"); bak = await child(node, "CtrlParamsBackUp")
    keys = sorted(WRITE_OK); rn, bn = {}, {}
    for k in keys:
        s_, m = k.split("/"); rn[k] = await child(await child(ret, s_), m); bn[k] = await child(await child(bak, s_), m)
    before = {k: float(dv.Value.Value) for k, dv in zip(keys, await c.read_attributes([rn[k] for k in keys], ua.AttributeIds.Value))}
    target = {**before, **{k: float(v) for k, v in req.items()}}
    for k in keys:
        await bn[k].write_value(ua.DataValue(ua.Variant(target[k], ua.VariantType.Float)))
    await (await child(bak, "SetByUser")).write_value(ua.DataValue(ua.Variant(True, ua.VariantType.Boolean)))
    lb = await child(node, "LoadBackUp")
    await lb.write_value(ua.DataValue(ua.Variant(True, ua.VariantType.Boolean)))
    await asyncio.sleep(2.0)
    after = {k: float(dv.Value.Value) for k, dv in zip(keys, await c.read_attributes([rn[k] for k in keys], ua.AttributeIds.Value))}
    lb_after = bool(await lb.read_value())
    ok = lambda a, b: abs(a - b) <= max(1e-6, abs(b) * 1e-5)
    res = {k: {"before": round(before[k], 6), "wrote": target[k], "read": round(after[k], 6), "ok": ok(after[k], target[k])} for k in req}
    others_ok = all(ok(after[k], before[k]) for k in keys if k not in req)
    print(json.dumps({"results": res, "loadBackUpCleared": not lb_after, "othersUnchanged": others_ok, "before": before, "after": after}))
async def main(inst, req=None):
    o = CFG["opcua"]; c = Client(o["endpoint"], timeout=10)
    async with c:
        ns = await c.get_namespace_index(o["interfaces_root"]["uri"])
        root = c.get_node(ua.NodeId(o["interfaces_root"]["id"], ns))
        node = None
        for iface in await root.get_children():
            for ch in await iface.get_children():
                if (await ch.read_browse_name()).Name == inst: node = ch; break
            if node: break
        if node is None: raise SystemExit(f"instance {inst} not found")
        if req is not None: return await write(c, node, req)
        tops = {(await ch.read_browse_name()).Name: ch for ch in await node.get_children()}
        leaves = []
        for t in ("Retain", "Config"):
            if t in tops: await walk(tops[t], t, leaves, 1)
        res = {}
        for i in range(0, len(leaves), 50):
            part = leaves[i:i+50]
            for (p, _), dv in zip(part, await c.read_attributes([n for _, n in part], ua.AttributeIds.Value)):
                if dv.StatusCode.is_good():
                    v = dv.Value.Value
                    res[p] = round(v, 6) if isinstance(v, float) else (v if isinstance(v, (int, bool, str)) else str(v))
        print(json.dumps(res, ensure_ascii=False))
if len(sys.argv) == 4 and sys.argv[2] == "--write":
    req = json.loads(sys.argv[3])
    bad = [k for k, v in req.items() if k not in WRITE_OK or not isinstance(v, (int, float))]
    if bad or not req: raise SystemExit(f"refused: {bad or 'empty'}")
    asyncio.run(main(sys.argv[1], req))
else:
    asyncio.run(main(sys.argv[1]))
