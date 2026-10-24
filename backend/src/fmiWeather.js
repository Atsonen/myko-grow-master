// FMI open data (opendata.fmi.fi WFS, no key) + NOAA SWPC space weather.
// - Observations: Nurmijärvi Röykkä (fmisid 101149, ~6 km from Rajamäki) for T/RH/cloud/precip/pressure;
//   wind from Helsinki-Vantaa airport (fmisid 100968) because Röykkä has no anemometer.
//   Hourly rows -> fmi_weather_obs (backfill: scripts/fmi-backfill.js; live: every 30 min, last 2 days).
// - Forecast: fmi::forecast::edited::weather::scandinavia::point::simple at Rajamäki -> fmi_weather_forecast every 3 h.
// - Space weather: SWPC Kp (observed + forecast), RTSW solar wind, FMI Nurmijärvi magnetometer (NUR) X-range.
//   Snapshot -> space_weather_log every 30 min; Kp 3h values -> space_weather_kp.
// API: GET /api/weather/fmi, GET /api/space-weather (in-memory cache 10 min; FMI limits 600 req/5 min).
export const LAT = 60.52, LON = 24.75, OBS_FMISID = 101149, WIND_FMISID = 100968;
const WFS = "https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=getFeature&storedquery_id=";
const OBS_PARAMS = "t2m,rh,td,n_man,r_1h,p_sea";
const WIND_PARAMS = "ws_10min,wg_10min,wd_10min";
const FC_PARAMS = "Temperature,Humidity,WindSpeedMS,WindGust,WindDirection,TotalCloudCover,Precipitation1h,WeatherSymbol3";

export const TABLES = [
  `CREATE TABLE IF NOT EXISTS fmi_weather_obs (
    obs_time DATETIME NOT NULL PRIMARY KEY,  -- UTC, hourly instant values
    fmisid INT NOT NULL, t2m DECIMAL(5,1) NULL, rh DECIMAL(5,1) NULL, td DECIMAL(5,1) NULL,
    cloud_okta DECIMAL(3,1) NULL, precip_1h DECIMAL(5,1) NULL, pressure DECIMAL(6,1) NULL,
    wind_fmisid INT NULL, ws DECIMAL(4,1) NULL, wg DECIMAL(4,1) NULL, wd SMALLINT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS fmi_weather_forecast (
    fetched_at DATETIME NOT NULL, forecast_time DATETIME NOT NULL,  -- UTC
    t DECIMAL(5,1) NULL, rh DECIMAL(5,1) NULL, ws DECIMAL(4,1) NULL, wg DECIMAL(4,1) NULL, wd SMALLINT NULL,
    cloud_pct DECIMAL(5,1) NULL, precip_1h DECIMAL(5,1) NULL, symbol SMALLINT NULL,
    PRIMARY KEY (fetched_at, forecast_time), INDEX idx_fmi_fc_time (forecast_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS space_weather_kp (
    time_tag DATETIME NOT NULL PRIMARY KEY, kp DECIMAL(4,2) NULL, kind VARCHAR(12) NULL,  -- observed/estimated/predicted
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS space_weather_log (
    at DATETIME NOT NULL PRIMARY KEY, kp_now DECIMAL(4,2) NULL, kp_max_24h_fc DECIMAL(4,2) NULL,
    sw_speed DECIMAL(6,1) NULL, sw_density DECIMAL(6,2) NULL, bz DECIMAL(5,2) NULL, bt DECIMAL(5,2) NULL,
    nur_dx_1h DECIMAL(7,1) NULL, aurora_level TINYINT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const num = (v) => { const n = Number(v); return v == null || v === "" || !Number.isFinite(n) ? null : n; };

/** Parse BsWfs simple response -> Map(timeISO -> {param: value}). */
export function parseSimple(xml) {
  const out = new Map();
  const re = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>\s*<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>\s*<BsWfs:ParameterValue>([^<]*)<\/BsWfs:ParameterValue>/g;
  for (const m of xml.matchAll(re)) {
    const row = out.get(m[1]) ?? {};
    row[m[2]] = num(m[3]);
    out.set(m[1], row);
  }
  return out;
}

export async function fmiQuery(sq, params) {
  const url = WFS + sq + "&" + new URLSearchParams(params).toString();
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "User-Agent": "Myko/1.0" } });
  const text = await r.text();
  if (!r.ok || text.includes("ExceptionReport")) throw new Error(`FMI ${sq} HTTP ${r.status}: ${(text.match(/ExceptionText>([^<]+)/) || [])[1] ?? ""}`);
  return text;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Fetch hourly obs (T/RH/... from Röykkä + wind from Vantaa) for [start,end] (<=168 h) and upsert. Returns rows. */
export async function fetchObs(query, start, end) {
  const base = { timestep: "60", starttime: iso(start), endtime: iso(end) };
  const a = parseSimple(await fmiQuery("fmi::observations::weather::simple", { ...base, fmisid: String(OBS_FMISID), parameters: OBS_PARAMS }));
  const w = parseSimple(await fmiQuery("fmi::observations::weather::simple", { ...base, fmisid: String(WIND_FMISID), parameters: WIND_PARAMS }));
  const rows = [];
  for (const t of new Set([...a.keys(), ...w.keys()])) {
    const x = a.get(t) ?? {}, y = w.get(t) ?? {};
    const vals = [x.t2m, x.rh, x.td, x.n_man, x.r_1h, x.p_sea, y.ws_10min, y.wg_10min, y.wd_10min];
    if (vals.every((v) => v == null)) continue;
    rows.push([new Date(t), OBS_FMISID, ...vals.slice(0, 6), WIND_FMISID, ...vals.slice(6)]);
  }
  if (rows.length)
    await query(
      `INSERT INTO fmi_weather_obs (obs_time, fmisid, t2m, rh, td, cloud_okta, precip_1h, pressure, wind_fmisid, ws, wg, wd)
       VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
       ON DUPLICATE KEY UPDATE t2m=VALUES(t2m), rh=VALUES(rh), td=VALUES(td), cloud_okta=VALUES(cloud_okta), precip_1h=VALUES(precip_1h),
         pressure=VALUES(pressure), ws=VALUES(ws), wg=VALUES(wg), wd=VALUES(wd)`,
      rows.flat());
  return rows.length;
}

async function fetchForecast() {
  const m = parseSimple(await fmiQuery("fmi::forecast::edited::weather::scandinavia::point::simple",
    { latlon: `${LAT},${LON}`, parameters: FC_PARAMS, timestep: "60" }));
  return [...m.entries()].map(([t, v]) => ({
    time: t, t: v.Temperature, rh: v.Humidity, ws: v.WindSpeedMS, wg: v.WindGust, wd: v.WindDirection,
    cloud: v.TotalCloudCover, precip: v.Precipitation1h, symbol: v.WeatherSymbol3,
  })).sort((a, b) => a.time.localeCompare(b.time));
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Myko/1.0" } });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return r.json();
}

async function fetchNur() {
  // FMI Nurmijärvi geophysical observatory magnetometer, 1-min X component; last 3 h.
  const xml = await fmiQuery("fmi::observations::magnetometer::simple",
    { place: "Nurmijärvi", parameters: "MAGNX_PT1M_AVG", starttime: iso(new Date(Date.now() - 3 * 3600_000)) });
  const pts = [...parseSimple(xml).entries()].map(([t, v]) => ({ t, x: v.MAGNX_PT1M_AVG })).filter((p) => p.x != null)
    .sort((a, b) => a.t.localeCompare(b.t));
  const last1h = pts.filter((p) => Date.parse(p.t) > Date.now() - 3600_000).map((p) => p.x);
  const dx = last1h.length ? Math.max(...last1h) - Math.min(...last1h) : null;
  // 10-min decimated series for a sparkline
  const series = pts.filter((_, i) => i % 5 === 0).map((p) => ({ time: p.t, x: Math.round(p.x * 10) / 10 }));
  return { station: "Nurmijärvi (NUR)", dx1h: dx == null ? null : Math.round(dx * 10) / 10, lastTime: pts.at(-1)?.t ?? null, series };
}

/** 0 = ei, 1 = epätodennäköinen, 2 = mahdollinen, 3 = todennäköinen, 4 = voimakas. Rajamäki ~60.5°N (geomag. ~57°). */
export function auroraLevel(kp, dx, cloud) {
  let lv = 0;
  if (kp != null) lv = kp >= 6 ? 4 : kp >= 5 ? 3 : kp >= 4 ? 2 : kp >= 3 ? 1 : 0;
  if (dx != null) lv = Math.max(lv, dx >= 300 ? 4 : dx >= 150 ? 3 : dx >= 80 ? 2 : dx >= 40 ? 1 : 0);
  return lv;
}
const AURORA_TEXT = ["Ei revontulia", "Epätodennäköinen", "Mahdollinen", "Todennäköinen", "Voimakas myrsky"];

function isDark(d = new Date()) {
  // crude solar elevation for LAT/LON: dark when sun < -6°
  const rad = Math.PI / 180, doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5);
  const decl = -23.44 * Math.cos(2 * Math.PI * (doy + 10) / 365);
  const ha = ((d.getUTCHours() + d.getUTCMinutes() / 60) * 15 + LON - 180);
  const el = Math.asin(Math.sin(LAT * rad) * Math.sin(decl * rad) + Math.cos(LAT * rad) * Math.cos(decl * rad) * Math.cos(ha * rad)) / rad;
  return el < -6;
}

export function registerFmiWeather(app, { query, asyncRoute }) {
  const cache = { weather: null, wAt: 0, space: null, sAt: 0 };
  const TTL = 10 * 60_000;
  const ready = (async () => { for (const s of TABLES) await query(s); })().catch((e) => console.error("[fmi] tables", e.message));

  async function buildWeather() {
    const [obsRows, fc] = await Promise.all([
      query("SELECT * FROM fmi_weather_obs WHERE obs_time > UTC_TIMESTAMP() - INTERVAL 30 HOUR ORDER BY obs_time"),
      fetchForecast(),
    ]);
    const last = obsRows.at(-1) ?? null;
    const lastWith = (k) => [...obsRows].reverse().find((r) => r[k] != null)?.[k] ?? null;
    const precip24 = obsRows.filter((r) => r.obs_time > new Date(Date.now() - 24 * 3600_000)).reduce((s, r) => s + (num(r.precip_1h) ?? 0), 0);
    const now = Date.now();
    const forecast = fc.filter((f) => Date.parse(f.time) >= now - 3600_000).slice(0, 48);
    return {
      source: "Ilmatieteen laitos (FMI) avoin data",
      station: { name: "Nurmijärvi Röykkä", fmisid: OBS_FMISID, windStation: "Helsinki-Vantaa lentoasema", windFmisid: WIND_FMISID },
      current: last && {
        time: last.obs_time, t: num(lastWith("t2m")), rh: num(lastWith("rh")), td: num(lastWith("td")),
        cloudOkta: num(lastWith("cloud_okta")), precip1h: num(last.precip_1h), precip24h: Math.round(precip24 * 10) / 10,
        pressure: num(lastWith("pressure")), ws: num(lastWith("ws")), wg: num(lastWith("wg")), wd: num(lastWith("wd")),
      },
      history: obsRows.map((r) => ({ time: r.obs_time, t: num(r.t2m), precip: num(r.precip_1h) })),
      forecast, forecastLocation: { lat: LAT, lon: LON, name: "Rajamäki" },
      fetchedAt: new Date().toISOString(),
    };
  }

  async function buildSpace() {
    const [kp, kpf, wind, mag, nur] = await Promise.allSettled([
      getJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
      getJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"),
      getJson("https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json"),
      getJson("https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json"),
      fetchNur(),
    ]);
    const ok = (p) => (p.status === "fulfilled" ? p.value : null);
    const errors = [kp, kpf, wind, mag, nur].filter((p) => p.status === "rejected").map((p) => p.reason?.message);
    const kpObs = (ok(kp) ?? []).map((r) => ({ time: r.time_tag + "Z", kp: num(r.Kp) })).filter((r) => r.kp != null);
    const fcAll = (ok(kpf) ?? []).map((r) => ({ time: r.time_tag + "Z", kp: num(r.kp), kind: r.observed, scale: r.noaa_scale }));
    const now = Date.now();
    const kpForecast = fcAll.filter((r) => Date.parse(r.time) + 3 * 3600_000 > now - 12 * 3600_000).slice(0, 20);
    const curFc = fcAll.find((r) => Date.parse(r.time) <= now && Date.parse(r.time) + 3 * 3600_000 > now);
    const kpNow = curFc?.kp ?? kpObs.at(-1)?.kp ?? null;
    const kpMax24 = Math.max(...fcAll.filter((r) => Date.parse(r.time) >= now - 3 * 3600_000 && Date.parse(r.time) < now + 24 * 3600_000).map((r) => r.kp ?? 0), 0);
    const w = (ok(wind) ?? []).find((r) => r.active && r.proton_speed != null) ?? null;
    const m = (ok(mag) ?? []).find((r) => r.active && r.bz_gsm != null) ?? null;
    const n = ok(nur);
    const [cl] = await query("SELECT cloud_okta FROM fmi_weather_obs WHERE cloud_okta IS NOT NULL ORDER BY obs_time DESC LIMIT 1").catch(() => []);
    const level = auroraLevel(kpNow, n?.dx1h ?? null);
    const dark = isDark();
    return {
      kpNow, kpMax24h: kpMax24, kpObserved: kpObs.slice(-8), kpForecast,
      solarWind: { time: w?.time_tag ? w.time_tag + "Z" : null, speed: num(w?.proton_speed), density: num(w?.proton_density),
        bz: num(m?.bz_gsm), bt: num(m?.bt) },
      magnetometer: n,
      aurora: { level, text: AURORA_TEXT[level], dark, cloudOkta: num(cl?.cloud_okta),
        note: level >= 2 && !dark ? "Liian valoisaa" : level >= 2 && num(cl?.cloud_okta) >= 7 ? "Pilvistä" : null },
      sources: ["NOAA SWPC (Kp, aurinkotuuli DSCOVR/ACE)", "Ilmatieteen laitos, Nurmijärven geofysiikan observatorio (magnetometri)"],
      errors, fetchedAt: new Date().toISOString(),
    };
  }

  async function getWeather() {
    if (!cache.weather || Date.now() - cache.wAt > TTL) { cache.weather = await buildWeather(); cache.wAt = Date.now(); }
    return cache.weather;
  }
  async function getSpace() {
    if (!cache.space || Date.now() - cache.sAt > TTL) { cache.space = await buildSpace(); cache.sAt = Date.now(); }
    return cache.space;
  }

  app.get("/api/weather/fmi", asyncRoute(async (_req, res) => res.json(await getWeather())));
  app.get("/api/space-weather", asyncRoute(async (_req, res) => res.json(await getSpace())));

  let lastFcStore = 0;
  async function tick() {
    await ready;
    const n = await fetchObs(query, new Date(Date.now() - 48 * 3600_000), new Date());
    cache.wAt = 0;
    const wx = await getWeather();
    if (Date.now() - lastFcStore > 3 * 3600_000 - 60_000 && wx.forecast.length) {
      const at = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      await query(`INSERT IGNORE INTO fmi_weather_forecast (fetched_at, forecast_time, t, rh, ws, wg, wd, cloud_pct, precip_1h, symbol) VALUES
        ${wx.forecast.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`,
        wx.forecast.flatMap((f) => [at, new Date(f.time), f.t, f.rh, f.ws, f.wg, f.wd, f.cloud, f.precip, f.symbol]));
      lastFcStore = Date.now();
    }
    cache.sAt = 0;
    const sp = await getSpace();
    const kpRows = [...sp.kpObserved.map((r) => [new Date(r.time), r.kp, "observed"]),
      ...sp.kpForecast.filter((r) => r.kind !== "observed").map((r) => [new Date(r.time), r.kp, r.kind])];
    if (kpRows.length)
      await query(`INSERT INTO space_weather_kp (time_tag, kp, kind) VALUES ${kpRows.map(() => "(?,?,?)").join(",")}
        ON DUPLICATE KEY UPDATE kp=IF(kind='observed' AND VALUES(kind)<>'observed', kp, VALUES(kp)), kind=IF(kind='observed', kind, VALUES(kind))`, kpRows.flat());
    await query(`INSERT IGNORE INTO space_weather_log (at, kp_now, kp_max_24h_fc, sw_speed, sw_density, bz, bt, nur_dx_1h, aurora_level) VALUES (?,?,?,?,?,?,?,?,?)`,
      [new Date(Math.floor(Date.now() / 60_000) * 60_000), sp.kpNow, sp.kpMax24h, sp.solarWind.speed, sp.solarWind.density, sp.solarWind.bz, sp.solarWind.bt,
       sp.magnetometer?.dx1h ?? null, sp.aurora.level]);
    console.log(`[fmi] obs rows=${n} T=${wx.current?.t} cloud=${wx.current?.cloudOkta} | Kp=${sp.kpNow} V=${sp.solarWind.speed} Bz=${sp.solarWind.bz} NUR dX=${sp.magnetometer?.dx1h} aurora=${sp.aurora.level}`);
  }
  const run = () => tick().catch((e) => console.error("[fmi]", e.message));
  setTimeout(run, 8_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
