// met.no Locationforecast 2.0 (compact) -> weather_metno. Outdoor temperature for pid_training_log (outdoor_tag 'metno').
// Terms: max 4 decimals in lat/lon, identifying User-Agent, respect Expires and use If-Modified-Since (304 = reuse body).
// Every 30 min: refetch only when Expires has passed, pick the timeseries entry nearest now, store one row.
const URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60.5309&lon=24.7966";
const UA = "Myko/1.0 github.com/Atsonen";
const EVERY_MS = 30 * 60_000;

export function startWeather({ query }) {
  let body = null, lastModified = null, expires = 0;
  async function fetchForecast() {
    if (body && Date.now() < expires) return "cached";
    const headers = { "User-Agent": UA, Accept: "application/json" };
    if (lastModified && body) headers["If-Modified-Since"] = lastModified;
    const r = await fetch(URL, { headers, signal: AbortSignal.timeout(20_000) });
    const exp = Date.parse(r.headers.get("expires") ?? "");
    expires = Number.isFinite(exp) ? exp : Date.now() + EVERY_MS;
    if (r.status === 304) return "304";
    if (!r.ok) throw new Error(`met.no HTTP ${r.status}`);
    body = await r.json();
    lastModified = r.headers.get("last-modified");
    return "200";
  }
  async function tick() {
    const how = await fetchForecast();
    const ts = body?.properties?.timeseries ?? [];
    const now = Date.now();
    const e = ts.reduce((b, x) => (!b || Math.abs(Date.parse(x.time) - now) < Math.abs(Date.parse(b.time) - now) ? x : b), null);
    if (!e) throw new Error("met.no: empty timeseries");
    const d = e.data?.instant?.details ?? {};
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    await query(
      `INSERT INTO weather_metno (fetched_at, forecast_time, air_temperature, relative_humidity, cloud_area_fraction, wind_speed, model_updated_at, http)
       VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?)`,
      [new Date(e.time), n(d.air_temperature), n(d.relative_humidity), n(d.cloud_area_fraction), n(d.wind_speed),
       body.properties?.meta?.updated_at ? new Date(body.properties.meta.updated_at) : null, how]);
    console.log(`[weather] ${how} ${e.time} T=${d.air_temperature} RH=${d.relative_humidity} cloud=${d.cloud_area_fraction} wind=${d.wind_speed}`);
  }
  const run = () => tick().catch((err) => console.error("[weather]", err.message));
  setTimeout(run, 5_000).unref();
  setInterval(run, EVERY_MS).unref();
}
