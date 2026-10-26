// Pumput_DB (väliaikainen Kasvamo-prosessinäkymän data, 26.10.2026). opcua-bridge pollaa (Read, 5 s) ja julkaisee
// Sensors/PLC_2/Pumput (flat JSON). VAIN LUKU – ei komentoja eikä kirjoituksia PLC:hen.
export function registerPumputRoutes(app, { mqttClient }) {
  let state = { at: 0, values: {} };
  const c = mqttClient();
  const sub = () => c.subscribe("Sensors/PLC_2/Pumput", { qos: 0 });
  c.on("connect", sub);
  if (c.connected) sub();
  c.on("message", (topic, buf) => {
    if (topic !== "Sensors/PLC_2/Pumput") return;
    try { state = { at: Date.now(), values: { ...state.values, ...JSON.parse(buf.toString()) } }; } catch { /* ignore */ }
  });
  app.get("/api/pumput", (_req, res) => {
    res.json({ at: state.at ? new Date(state.at).toISOString() : null, stale: !state.at || Date.now() - state.at > 60_000, values: state.values });
  });
}
