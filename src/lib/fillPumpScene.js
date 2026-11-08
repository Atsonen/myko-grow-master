// IEC-henkinen täyttöpumpun symboli. Ei vaatimustenmukaisuusväite.
// Lähtö = kirjattu Pump || St_Running. Run-bittiä ei tulkita käynniksi eikä virtaukseksi.
export const ESTIMATE_LABEL = "Suuntaa-antava arvio · ei mittaus";
export const FILL_GRAPHIC = { x: 828, y: 208, pumpX: 892 };
export const FILL_DISCHARGE_PATH = "M 360 320 V 230 H 892";

const OUTPUT_NOTE = "Tallennettu lähtö · ei virtausmittausta";

/** Wall time for the UI. The estimate itself stays pump-runtime seconds. */
export function formatHelsinki(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("fi-FI", {
    timeZone: "Europe/Helsinki",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

export function buildFillPresentation(fill, estimate, estimateError = null) {
  const plc = fill?.plc ?? null;
  const live = !!fill?.present && fill?.stale !== true;
  const recordedOn = plc?.Pump === true || plc?.St_Running === true;
  let outputKind = "unknown";
  let outputLabel = "Tila ei tiedossa";
  let outputDetail = "";
  if (fill && !live) {
    outputLabel = fill.stale ? "Vanha tieto" : "Tila ei tiedossa";
    if (plc?.Pump === true || plc?.St_Running === true) outputDetail = "Kirjaus: päällä";
    else if (plc?.Pump === false && plc?.St_Running === false) outputDetail = "Kirjaus: pois";
  } else if (live && recordedOn) {
    outputKind = "on";
    outputLabel = "Lähtö päällä";
    outputDetail = "Tuore kirjaus";
  } else if (live) {
    outputKind = "off";
    outputLabel = "Lähtö pois";
    outputDetail = "Tuore kirjaus";
  }
  const alarm = plc?.St_Error === true || Object.values(fill?.alarms?.active ?? {}).some(Boolean);
  let enableKind = "unknown";
  let enableLabel = "Sallinta tuntematon";
  const enableWritable = live && typeof plc?.Cfg_Enable === "boolean" && !!fill?.write_allowed;
  if (live && typeof plc?.Cfg_Enable === "boolean") {
    enableKind = plc.Cfg_Enable ? "allowed" : "blocked";
    enableLabel = plc.Cfg_Enable ? "Täyttö sallittu" : "Täyttö estetty";
  }
  let tankMode = "unavailable";
  let coarsePct = null;
  let qualityLabel = estimateError ? "Arvio ei saatavilla" : "Laatu ei tiedossa";
  if (estimate?.ok && estimate.available && typeof estimate.remainingCoarsePct === "number") {
    tankMode = "level";
    coarsePct = estimate.remainingCoarsePct;
    qualityLabel = estimate.quality === "ok" ? "Tuore kirjaus" : estimate.quality === "stale" ? "Vanha kirjaus" : "Laatu tuntematon";
  } else if (estimate?.ok && estimate.available === false) {
    tankMode = "empty";
    qualityLabel = "Ei arviota";
  }
  return {
    outputKind,
    outputLabel,
    outputDetail,
    outputNote: OUTPUT_NOTE,
    enableKind,
    enableLabel,
    enableWritable,
    fault: !!alarm,
    bellTitle: live ? "Hälytys · avaa täyttöpumpun ikkuna (ei kuittausta)" : "Viimeisin hälytystieto · avaa ikkuna (ei kuittausta)",
    pipeAnimate: outputKind === "on",
    tankMode,
    coarsePct,
    qualityLabel,
    label: ESTIMATE_LABEL,
    zeroNote: coarsePct === 0 ? "Ei mitattu tyhjä" : null,
    meaning: "Käyntiosuus · ei kelloaikaa, litraa eikä korkeutta",
    noAnchorNote: tankMode === "empty" ? "Ei ankkuria" : null,
  };
}

export function fillActionEffect(action, pres) {
  if (action === "bell" || action === "status" || action === "output") {
    return { type: "open-modal", ack: false, plcWrite: false };
  }
  if (action === "enable") {
    if (!pres?.enableWritable || pres?.busy) return { type: "none", ack: false, plcWrite: false };
    const next = pres.enableKind !== "allowed";
    return {
      type: "confirm-enable",
      next,
      ack: false,
      plcWrite: "Cfg_Enable",
      confirmText: next
        ? "Vahvista: Cfg_Enable → TRUE (täyttö sallittu)? Ei käynnistä pumppua."
        : "Vahvista: Cfg_Enable → FALSE (täyttö estetty)? Sallintakytkin, ei käyntikomento.",
    };
  }
  if (action === "tank") return { type: "open-source", ack: false, plcWrite: false };
  if (action === "refill") {
    if (pres?.busy) return { type: "none", ack: false, plcWrite: false };
    return {
      type: "confirm-refill",
      ack: false,
      plcWrite: false,
      confirmText: "Vahvista: Säiliö täytetty (täysi säiliö)? Nollaa vain arvion ankkurin. Ei osittaistäyttöä, ei pumpun käynnistystä eikä vikakuittauksia.",
    };
  }
  if (action === "reference") {
    if (pres?.busy) return { type: "none", ack: false, plcWrite: false };
    return {
      type: "confirm-reference",
      ack: false,
      plcWrite: false,
      confirmText: "Vahvista viiteajan vaihto? Kertynyt käyntiaika säilyy. Ei kirjoita pumppua.",
    };
  }
  return { type: "none", ack: false, plcWrite: false };
}

export function sourceDialogModel(estimate) {
  return {
    title: "Täyttövesi · lähdesäiliö",
    label: ESTIMATE_LABEL,
    meaning: "Osuus viitekäyntiajasta. Ei seinäkelloaika, litraa eikä pinnankorkeutta.",
    fullRefill: "Säiliö täytetty",
    fullRefillHelp: "Merkitsee täyden säiliön. Ei osittaistäyttöä, ei pumpun käynnistystä eikä vikakuittauksia.",
    refHelp: "Viiteajan vaihto säilyttää kertyneen käyntiajan ja kirjaa vanhan sekä uuden arvon.",
    noAnchor: "Arviota ei ole, ennen kuin säiliö merkitään täytetyksi.",
    zeroNote: "0 % ei ole mitattu tyhjä.",
    referenceS: estimate?.referenceS ?? 1320,
    accumulatedS: estimate?.accumulatedS ?? null,
    coarsePct: estimate?.available ? estimate.remainingCoarsePct : null,
    available: !!estimate?.available,
    qualityNote: estimate?.qualityNote ?? "",
    refLog: (estimate?.refLog ?? []).map((r) => ({ ...r, atLabel: formatHelsinki(r.at ?? r.atMs) })),
  };
}

function actionAttr(action, interactive) {
  if (!interactive || !action) return "";
  return ` data-action="${action}" style="cursor:pointer"`;
}

export const FILL_SCENE = { w: 128, h: 292 };

export function renderFillPumpInner(pres, { interactive = true, clipId = "fill-tank-clip" } = {}) {
  const p = pres;
  const stroke = p.outputKind === "on" ? "#22c55e" : p.outputKind === "off" ? "#94a3b8" : "#64748b";
  const pumpCx = 64;
  const pumpCy = 42;
  const pumpR = 15;
  const tankX = 12;
  const tankY = 112;
  const tankW = 104;
  const tankH = 108;
  const innerTop = tankY + 40;
  const innerH = tankH - 48;
  const levelH = p.tankMode === "level" && p.coarsePct != null ? (innerH * p.coarsePct) / 100 : 0;
  const pctText = p.tankMode === "level" ? `${p.coarsePct} %` : p.tankMode === "empty" ? "Ei arviota" : "–";
  const statusY = tankY + tankH + 16;
  const detailY = statusY + 11;
  const enableY = detailY + 6;
  const noteY = enableY + 28;
  const bell = p.fault ? `
    <g data-testid="fill-alarm-bell"${actionAttr("bell", interactive)}>
      <title>${esc(p.bellTitle)}</title>
      <circle cx="108" cy="24" r="10" fill="#7f1d1d" stroke="#ef4444" stroke-width="1.4"/>
      <path d="M108 17 v1.2 a4.2 4.2 0 0 1 4.2 4.2 v2.2 l1.4 1.6 h-11.2 l1.4-1.6 v-2.2 a4.2 4.2 0 0 1 4.2-4.2z" fill="#fecaca"/>
      <circle cx="108" cy="28" r="1.2" fill="#fecaca"/>
    </g>` : "";
  const suctionAnim = p.pipeAnimate
    ? `<line x1="${pumpCx}" y1="${pumpCy + pumpR}" x2="${pumpCx}" y2="${tankY}" stroke="#38bdf8" stroke-width="6" stroke-linecap="butt" data-testid="fill-suction" data-pipe-animate="true"/>
       <line x1="${pumpCx}" y1="${pumpCy + pumpR}" x2="${pumpCx}" y2="${tankY}" stroke="#bfdbfe" stroke-width="2" stroke-dasharray="5 7" stroke-linecap="butt">
         <animate attributeName="stroke-dashoffset" from="12" to="0" dur="1s" repeatCount="indefinite"/>
       </line>`
    : `<line x1="${pumpCx}" y1="${pumpCy + pumpR}" x2="${pumpCx}" y2="${tankY}" stroke="#475569" stroke-width="6" stroke-linecap="butt" data-testid="fill-suction" data-pipe-animate="false"/>`;
  const level = p.tankMode === "level" ? `
    <clipPath id="${esc(clipId)}"><rect x="${tankX + 2}" y="${innerTop}" width="${tankW - 4}" height="${innerH}" rx="3"/></clipPath>
    <rect data-testid="fill-tank-level" data-pct="${p.coarsePct}" x="${tankX + 2}" y="${innerTop + innerH - levelH}" width="${tankW - 4}" height="${levelH}" fill="#0284c7" clip-path="url(#${esc(clipId)})"/>` : `<rect data-testid="fill-tank-empty" x="${tankX + 2}" y="${innerTop}" width="${tankW - 4}" height="${innerH}" fill="none"/>`;
  const enableAction = p.enableWritable ? actionAttr("enable", interactive) : "";
  return `
    <title>Täyttöpumppu. IEC-henkinen havainne, ei vaatimustenmukaisuusväite. ${esc(p.outputNote)}</title>
    <text x="${pumpCx}" y="12" text-anchor="middle" fill="#e2e8f0" font-size="11" font-family="ui-monospace,monospace">Täyttö</text>
    ${bell}
    ${suctionAnim}
    <g data-testid="fill-pump-symbol"${actionAttr("status", interactive)}>
      <circle cx="${pumpCx}" cy="${pumpCy}" r="${pumpR}" fill="${p.fault ? "#3f1212" : "#1e293b"}" stroke="${p.fault ? "#ef4444" : stroke}" stroke-width="2.4"/>
      <line x1="${pumpCx - 9}" y1="${pumpCy}" x2="${pumpCx + 9}" y2="${pumpCy}" stroke="${stroke}" stroke-width="1.4"/>
      <line x1="${pumpCx}" y1="${pumpCy - 9}" x2="${pumpCx}" y2="${pumpCy + 9}" stroke="${stroke}" stroke-width="1.4"/>
      <path d="M${pumpCx - 8} ${pumpCy - pumpR} L${pumpCx + 8} ${pumpCy - pumpR} L${pumpCx} 22 Z" fill="${stroke}"/>
    </g>
    <g data-testid="fill-source-tank"${actionAttr("tank", interactive)}>
      <rect x="${tankX}" y="${tankY}" width="${tankW}" height="${tankH}" rx="8" fill="#0b1220" stroke="#38bdf8" stroke-width="1.6"/>
      <text x="${pumpCx}" y="${tankY + 14}" text-anchor="middle" fill="#e2e8f0" font-size="8" font-family="ui-monospace,monospace">Täyttövesi</text>
      <text x="${pumpCx}" y="${tankY + 25}" text-anchor="middle" fill="#94a3b8" font-size="6" font-family="ui-monospace,monospace">Suuntaa-antava arvio</text>
      <text x="${pumpCx}" y="${tankY + 34}" text-anchor="middle" fill="#94a3b8" font-size="6" font-family="ui-monospace,monospace">· ei mittaus</text>
      ${level}
      <text data-testid="fill-estimate-pct" x="${pumpCx}" y="${tankY + 72}" text-anchor="middle" fill="#e0f2fe" font-size="${p.tankMode === "level" ? 16 : 11}" font-family="ui-monospace,monospace" font-weight="700">${esc(pctText)}</text>
      <text data-testid="fill-quality" x="${pumpCx}" y="${tankY + 98}" text-anchor="middle" fill="#fde68a" font-size="7" font-family="ui-monospace,monospace">${esc(p.zeroNote || p.noAnchorNote || p.qualityLabel)}</text>
    </g>
    <text data-testid="fill-output-label" x="${pumpCx}" y="${statusY}" text-anchor="middle" fill="${p.outputKind === "on" ? "#86efac" : p.outputKind === "off" ? "#cbd5e1" : "#fbbf24"}" font-size="9" font-family="ui-monospace,monospace"${actionAttr("output", interactive)}>${esc(p.outputLabel)}</text>
    <text data-testid="fill-output-detail" x="${pumpCx}" y="${detailY}" text-anchor="middle" fill="#94a3b8" font-size="7" font-family="ui-monospace,monospace">${esc(p.outputDetail || "")}</text>
    <g data-testid="fill-enable"${enableAction} opacity="${p.enableWritable ? 1 : 0.55}">
      <rect x="6" y="${enableY}" width="116" height="16" rx="8" fill="${p.enableKind === "allowed" ? "#14532d" : "#27272a"}" stroke="${p.enableKind === "unknown" ? "#52525b" : "#3f3f46"}"/>
      <text x="${pumpCx}" y="${enableY + 11}" text-anchor="middle" fill="#fff" font-size="8" font-family="ui-monospace,monospace">${esc(p.enableLabel)}</text>
    </g>
    <text x="${pumpCx}" y="${noteY}" text-anchor="middle" fill="#64748b" font-size="7" font-family="ui-monospace,monospace">Ei virtausmittausta</text>`;
}

export function renderExampleHtml() {
  const fault = buildFillPresentation(
    {
      present: false,
      stale: true,
      write_allowed: true,
      plc: { Pump: true, St_Running: true, Run: true, St_Error: true, St_ErrCode: 1, Cfg_Enable: true },
      alarms: { active: { err_1: true } },
    },
    { ok: true, available: false, referenceS: 1320, quality: "unknown", qualityNote: "ei ankkuria" },
  );
  const running = buildFillPresentation(
    {
      present: true,
      stale: false,
      write_allowed: true,
      plc: { Pump: true, St_Running: true, Run: false, St_Error: false, Cfg_Enable: true },
      alarms: { active: {} },
    },
    {
      ok: true,
      available: true,
      referenceS: 1320,
      accumulatedS: 660,
      remainingCoarsePct: 50,
      quality: "ok",
      qualityNote: "Tuore MQTT-tila.",
      refLog: [{ at: "2026-11-08T08:25:00.000Z", oldS: 1320, newS: 1320, by: "esimerkki" }],
    },
  );
  const dialog = sourceDialogModel({
    referenceS: 1320,
    accumulatedS: 660,
    available: true,
    remainingCoarsePct: 50,
    qualityNote: running.qualityLabel,
    refLog: [{ at: "2026-11-08T08:25:00.000Z", oldS: 1200, newS: 1320, by: "esimerkki" }],
  });
  const card = (title, pres, clipId) => `
    <section>
      <h2>${esc(title)}</h2>
      <svg viewBox="0 0 ${FILL_SCENE.w} ${FILL_SCENE.h}" width="256" height="584">${renderFillPumpInner(pres, { clipId })}</svg>
    </section>`;
  return `<!DOCTYPE html>
<html lang="fi"><head><meta charset="utf-8"><title>Täyttöpumppu esimerkki</title>
<style>
  body { margin: 0; background: #0f172a; color: #e2e8f0; font-family: ui-monospace, monospace; }
  .banner { background: #7c2d12; color: #ffedd5; padding: 10px 16px; font-size: 14px; }
  .row { display: flex; gap: 24px; padding: 16px; align-items: flex-start; flex-wrap: wrap; }
  section { background: #111827; border: 1px solid #334155; border-radius: 8px; padding: 8px 12px 16px; }
  h2 { font-size: 13px; font-weight: 600; margin: 8px 0; }
  .dlg { width: 320px; border: 1px solid #38bdf8; border-radius: 8px; padding: 12px; background: #0b1220; }
  .dlg h3 { margin: 0 0 8px; font-size: 14px; }
  .dlg p, .dlg li { font-size: 12px; line-height: 1.4; color: #cbd5e1; }
  button { font-family: inherit; margin: 4px 4px 0 0; }
</style></head>
<body>
  <div class="banner">ESIMERKKI · ei tuotantodataa · mockattu näkymä</div>
  <div class="row">
    ${card("1 · vika ja tuntematon tila, ei ankkuria", fault, "ex-tank-fault")}
    ${card("2 · ankkuroitu kirjattu lähtö, 660 s / 1320 s ≈ 50 %", running, "ex-tank-run")}
    <section class="dlg">
      <h3>${esc(dialog.title)}</h3>
      <p>${esc(dialog.label)}</p>
      <p>${esc(dialog.meaning)}</p>
      <p>Viite ${dialog.referenceS} s · kertymä ${dialog.accumulatedS} s · ${dialog.coarsePct} %</p>
      <p>${esc(dialog.fullRefillHelp)}</p>
      <p>${esc(dialog.refHelp)}</p>
      <p>Viimeisin viitemuutos: ${esc(dialog.refLog[0]?.oldS)} s → ${esc(dialog.refLog[0]?.newS)} s · ${esc(dialog.refLog[0]?.atLabel)} Helsinki</p>
      <button type="button">${esc(dialog.fullRefill)}</button>
      <button type="button">Tallenna viite</button>
    </section>
  </div>
</body></html>`;
}
