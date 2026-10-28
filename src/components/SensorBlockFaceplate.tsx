// SensorBlock faceplate: telemetria + Schema>=4 komennot (testioverridet, puhallin).
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  getSensorBlock,
  getSensorBlocks,
  postSensorBlockCommand,
  type SensorBlockItem,
  type SensorBlockListResponse,
} from "@/lib/apiClient";
import { toast } from "sonner";

const CW_BITS = [
  { bit: 0, name: "Aht" },
  { bit: 1, name: "Dallas" },
  { bit: 2, name: "Tds" },
  { bit: 3, name: "Ph" },
  { bit: 4, name: "Heating" },
  { bit: 5, name: "Fan" },
] as const;

const ACK_FI: Record<string, string> = {
  restart_confirm: "Uudelleenkäynnistys vaatii confirm=<laitenimi>",
  restart_exclusive: "restart-komento pitää lähettää yksin (ei muita kenttiä)",
  ota: "OTA-päivitys käynnissä / estetty",
  settings: "settings-komento hylätty",
  sensor_tests: "sensorTests hylätty",
  outputs:
    "lähdöt hylkäsivät (outputs) — TestMode=true estää fyysiset lähdöt, tai ControlWord.Fan/Heating pois",
  no_fields: "ei kenttiä",
  invalid_json: "virheellinen JSON",
  timeout: "timeout — laite ei vastannut",
  ack_failed: "kuittaus epäonnistui",
};

const TEST_KEYS = [
  "AhtTemp1", "AhtHum1",
  "DStemp1", "DStemp2", "DStemp3", "DStemp4", "DStemp5", "DStemp6", "DStemp7", "DStemp8",
  "Tds", "Tds25", "PH", "PHr", "kPa",
] as const;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ageLabel = (ms: number | null | undefined) => {
  if (ms == null) return "—";
  if (ms < 5_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
};

function Badge({ kind, children }: { kind: "alarm" | "warning" | "ok" | "info" | "muted" | "test"; children: React.ReactNode }) {
  const c = {
    alarm: "bg-red-600 text-white",
    warning: "bg-amber-400 text-zinc-900",
    ok: "bg-emerald-600 text-white",
    info: "bg-sky-700 text-white",
    muted: "bg-zinc-700 text-zinc-200",
    test: "bg-fuchsia-600 text-white animate-pulse",
  }[kind];
  return <span className={`inline-block rounded px-1.5 py-px text-[11px] font-bold uppercase tracking-wide ${c}`}>{children}</span>;
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function useSensorBlocks(intervalMs = 3000) {
  const [data, setData] = useState<SensorBlockListResponse | null>(null);
  const load = () => getSensorBlocks().then(setData).catch(() => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return { data, load, items: data?.items ?? [], devices: data?.devices ?? [] };
}

export function SensorBlockCard({
  item,
  onOpen,
}: {
  item: SensorBlockItem;
  onOpen: () => void;
}) {
  const v = item.values;
  const temp =
    typeof v?.DStemp1 === "number" && v.DStemp1 > -119
      ? v.DStemp1
      : typeof v?.AhtTemp1 === "number" && v.AhtTemp1 > -119
        ? v.AhtTemp1
        : null;
  const hum = typeof v?.AhtHum1 === "number" && v.AhtHum1 > -119 ? v.AhtHum1 : null;
  return (
    <button
      type="button"
      data-testid={`sb-card-${item.device}`}
      onClick={onOpen}
      className={`w-full rounded-md border border-border bg-secondary/20 p-3 text-left hover:bg-muted/30 ${item.stale ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{item.device}</span>
        {(item.hasActiveTests || (Array.isArray(item.sensorTests) && item.sensorTests.length > 0)) && <Badge kind="test">TESTI</Badge>}
        {item.schema != null && <Badge kind="muted">Schema {item.schema}</Badge>}
        {item.stale ? <Badge kind="warning">Vanha</Badge> : <Badge kind="ok">Live</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap gap-3 font-mono text-xs tabular-nums text-muted-foreground">
        <span>T {temp == null ? "—" : `${temp} °C`}</span>
        <span>RH {hum == null ? "—" : `${hum} %`}</span>
        <span>RSSI {item.rssi ?? "—"} dBm</span>
        <span className="ml-auto">{ageLabel(item.ageMs)}</span>
      </div>
    </button>
  );
}

export function SensorBlockFaceplate({
  open,
  onClose,
  initialDevice,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  initialDevice?: string;
  devices: string[];
}) {
  const [dev, setDev] = useState(initialDevice ?? devices[0] ?? "SensorBlock_1");
  const [item, setItem] = useState<SensorBlockItem | null>(null);
  const [tab, setTab] = useState<"tele" | "testit" | "puhallin" | "asetukset">("tele");
  const [hideDisabled, setHideDisabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ackMsg, setAckMsg] = useState<string | null>(null);
  const [testKey, setTestKey] = useState<string>("Tds");
  const [testVal, setTestVal] = useState("1500");
  const [fanPct, setFanPct] = useState(0);
  const [cwDraft, setCwDraft] = useState<number>(0);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartStatus, setRestartStatus] = useState<string | null>(null);
  const [, setUptimeSnap] = useState<number | null>(null);

  useEffect(() => {
    if (initialDevice) setDev(initialDevice);
  }, [initialDevice, open]);

  useEffect(() => {
    if (!open || !dev) return;
    let stop = false;
    const load = () =>
      getSensorBlock(dev)
        .then((r) => {
          if (!stop) {
            setItem(r);
            if (typeof r.fanDutyPercent === "number") setFanPct(r.fanDutyPercent);
            const cw = r.values?.ControlWord;
            if (typeof cw === "number" && Number.isFinite(cw)) setCwDraft(cw);
          }
        })
        .catch(() => undefined);
    load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [open, dev]);

  const overrides = useMemo(() => {
    const st = item?.sensorTests;
    if (Array.isArray(st) && st.length) return new Set(st.map(String));
    // Some firmwares may publish object map under values.SensorTests
    const raw = item?.values?.SensorTests;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return new Set(Object.keys(raw as object));
    return new Set<string>();
  }, [item]);

  const rows = useMemo(() => {
    const v = item?.values;
    if (!v) return [];
    const keys = Object.keys(v).filter((k) => k !== "SensorTests");
    const preferred = [
      "AhtTemp1", "AhtHum1",
      "DStemp1", "DStemp2", "DStemp3", "DStemp4", "DStemp5", "DStemp6", "DStemp7", "DStemp8",
      "Tds", "Tds25", "PH", "PHr", "kPa", "RSSI", "Uptime",
      "Heat", "HeatRequested", "FanRequestedPercent", "FanDutyPercent", "FanPWM",
      "TestMode", "Status", "Schema", "ControlWord", "ConfigCached",
    ];
    const ordered = [...preferred.filter((k) => k in v), ...keys.filter((k) => !preferred.includes(k))];
    return ordered
      .map((k) => {
        const dec = item?.decoded?.[k] ?? null;
        return { key: k, raw: v[k], dec };
      })
      .filter((r) => {
        if (!hideDisabled) return true;
        return !(r.dec?.kind === "error" && r.dec.disabled);
      });
  }, [item, hideDisabled]);

  const canCmd = Boolean(item?.commandsSupported);
  const canSettings = Boolean(item?.settingsSupported) || (item?.schema != null && item.schema >= 5);

  const settingsOverridden: string[] = Array.isArray(item?.settingsOverridden)
    ? item!.settingsOverridden!
    : Array.isArray(item?.values?.SettingsOverridden)
      ? (item!.values!.SettingsOverridden as unknown[]).map(String)
      : [];

  const ackLabel = (err?: string) => (err ? (ACK_FI[err] ?? err) : "virhe");

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setAckMsg(null);
    try {
      const r = await postSensorBlockCommand(dev, body);
      if (r.ok) {
        setAckMsg(`OK ${JSON.stringify(r.ack ?? {})}`);
        toast.success("Komento kuitattu");
      } else {
        const m = (r as { message?: string }).message || ackLabel(r.error);
        let extra = "";
        if (r.error === "outputs" && item?.testMode) {
          extra = " · TestMode=true: fyysiset lähdöt pois → FanDuty saa usein outputs-virheen";
        }
        setAckMsg(`Virhe: ${m}${extra} · ${JSON.stringify(r.ack ?? {})}`);
        toast.error(m);
      }
      const fresh = await getSensorBlock(dev);
      setItem(fresh);
      const cw = fresh.values?.ControlWord;
      if (typeof cw === "number" && Number.isFinite(cw)) setCwDraft(cw);
      return r;
    } catch (e) {
      const m = errMsg(e);
      setAckMsg(m);
      toast.error(m);
      return { ok: false, error: m };
    } finally {
      setBusy(false);
    }
  };

  const toggleCwBit = (bit: number) => {
    setCwDraft((prev) => (prev ^ (1 << bit)) & 0xffff);
  };

  const doRestart = async () => {
    setRestartOpen(false);
    setRestartStatus("Käynnistetään uudelleen…");
    setBusy(true);
    setAckMsg(null);
    const before = typeof item?.uptime === "number" ? item.uptime : typeof item?.values?.Uptime === "number" ? (item.values.Uptime as number) : null;
    setUptimeSnap(before);
    try {
      const r = await postSensorBlockCommand(dev, { restart: true, confirm: dev });
      if (!r.ok) {
        const m = (r as { message?: string }).message || ackLabel(r.error);
        setAckMsg(`Virhe: ${m} · ${JSON.stringify(r.ack ?? {})}`);
        setRestartStatus(null);
        toast.error(m);
        setBusy(false);
        return;
      }
      const ack = r.ack as { restarting?: boolean } | undefined;
      setAckMsg(`OK ${JSON.stringify(r.ack ?? {})}`);
      toast.success(ack?.restarting ? "Uudelleenkäynnistys käynnissä" : "Komento kuitattu");
      // Watch Uptime reset (poll up to ~90 s)
      const deadline = Date.now() + 90_000;
      let ok = false;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 2000));
        try {
          const fresh = await getSensorBlock(dev);
          setItem(fresh);
          const up = typeof fresh.uptime === "number" ? fresh.uptime : typeof fresh.values?.Uptime === "number" ? (fresh.values.Uptime as number) : null;
          if (up != null && (before == null || up < before || up <= 1)) {
            // also accept uptime small after reboot
            if (before == null || up < before || (before > 1 && up <= 1) || up === 0) {
              ok = true;
              setItem(fresh);
              const cw = fresh.values?.ControlWord;
              if (typeof cw === "number") setCwDraft(cw);
              break;
            }
          }
        } catch {
          /* still rebooting */
        }
      }
      if (ok) {
        setRestartStatus("käynnistyi uudelleen");
        toast.success("käynnistyi uudelleen");
      } else {
        setRestartStatus("timeout — ei nähty Uptime-resettiä");
        toast.error("Uudelleenkäynnistyksen seuranta aikakatkaistiin");
      }
    } catch (e) {
      const m = errMsg(e);
      setAckMsg(m);
      setRestartStatus(null);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto font-mono" data-testid="sb-faceplate">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            SensorBlock
            <select
              aria-label="Laite"
              data-testid="sb-device"
              value={dev}
              onChange={(e) => setDev(e.target.value)}
              className="h-8 rounded border border-input bg-background px-2 text-sm"
            >
              {(devices.length ? devices : [dev]).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            {(item?.hasActiveTests || (Array.isArray(item?.sensorTests) && item.sensorTests.length > 0)) && <Badge kind="test">TESTI</Badge>}
            {item?.schema != null && <Badge kind="info">Schema {item.schema}</Badge>}
            {item?.testMode && <Badge kind="warning">TestMode</Badge>}
            {settingsOverridden.length > 0 && (
              <Badge kind="test">ASETUS OHITETTU (RAM)</Badge>
            )}
            {item?.stale ? <Badge kind="warning">Vanha data</Badge> : item ? <Badge kind="ok">Live</Badge> : null}
            <span className="ml-auto text-xs font-normal text-muted-foreground">nähty {ageLabel(item?.ageMs)}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border px-1">
          {([
            ["tele", "Telemetria"],
            ["testit", "Testit"],
            ["puhallin", "Puhallin"],
            ["asetukset", "Asetukset"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`sb-tab-${id}`}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-xs uppercase tracking-wide ${tab === id ? "border-b-2 border-sky-400 text-foreground" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-3 p-1">
          {tab === "tele" && (
            <>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={hideDisabled} onChange={(e) => setHideDisabled(e.target.checked)} data-testid="sb-hide-disabled" />
                Piilota Disabled (-122)
              </label>
              <Section title="Anturit / tilat" right={<span className="text-[10px] text-muted-foreground">{rows.length} kenttää</span>}>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {rows.map((r) => {
                    const overridden = overrides.has(r.key);
                    const isErr = r.dec?.kind === "error";
                    const text = r.dec?.text ?? String(r.raw);
                    return (
                      <div
                        key={r.key}
                        data-testid={`sb-field-${r.key}`}
                        className={`flex justify-between gap-2 border-b border-border/40 px-1 py-0.5 text-xs ${overridden ? "bg-fuchsia-500/15" : ""}`}
                      >
                        <span className="text-muted-foreground">
                          {r.key}
                          {overridden && <span className="ml-1 text-fuchsia-300">●</span>}
                        </span>
                        <span className={`tabular-nums ${isErr ? "text-amber-300" : overridden ? "text-fuchsia-200" : ""}`}>{text}</span>
                      </div>
                    );
                  })}
                  {!rows.length && <div className="text-xs text-muted-foreground italic">Ei telemetriaa vielä.</div>}
                </div>
              </Section>
              <Section title="ControlWord">
                <div className="flex flex-wrap gap-2 text-xs">
                  {(item?.controlWord ?? []).map((b) => (
                    <span key={b.name} className={`rounded border px-2 py-0.5 ${b.on ? "border-emerald-500/60 text-emerald-300" : "border-border text-muted-foreground"}`}>
                      {b.name} {b.on ? "ON" : "off"}
                    </span>
                  ))}
                  {!item?.controlWord?.length && <span className="text-muted-foreground">—</span>}
                </div>
              </Section>
              <Section title="Lähtö / tila">
                <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3">
                  <div>Heat: <b>{item?.heat == null ? "—" : item.heat ? "ON" : "OFF"}</b></div>
                  <div>HeatReq: <b>{item?.heatRequested == null ? "—" : item.heatRequested ? "ON" : "OFF"}</b></div>
                  <div>FanReq: <b>{item?.fanRequestedPercent ?? "—"} %</b></div>
                  <div>FanDuty: <b>{item?.fanDutyPercent ?? "—"} %</b></div>
                  <div>FanPWM: <b>{item?.fanPwm ?? "—"}</b></div>
                  <div>Status: <b>{item?.status ?? "—"}</b></div>
                  <div>TestMode: <b>{item?.testMode ? "ON" : "OFF"}</b></div>
                  <div>Schema: <b>{item?.schema ?? "—"}</b></div>
                </div>
              </Section>
            </>
          )}

          {tab === "testit" && (
            <Section title="Sensoritestit (overridet)">
              {!canCmd ? (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100" data-testid="sb-no-cmd">
                  ei tue komentoja {item?.schema != null ? `(Schema ${item.schema} < 4)` : "(ei Schema-tietoa)"}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="text-xs">
                      Anturi
                      <select value={testKey} onChange={(e) => setTestKey(e.target.value)} className="mt-1 block h-9 rounded border border-input bg-background px-2" data-testid="sb-test-key">
                        {TEST_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </label>
                    <label className="text-xs">
                      Arvo
                      <input value={testVal} onChange={(e) => setTestVal(e.target.value)} className="mt-1 block h-9 w-28 rounded border border-input bg-background px-2 tabular-nums" data-testid="sb-test-val" />
                    </label>
                    <Button size="sm" disabled={busy} data-testid="sb-test-set" onClick={() => send({ sensorTests: { [testKey]: { value: Number(testVal.replace(",", ".")) } } })}>
                      Aseta
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} data-testid="sb-test-clear-one" onClick={() => send({ sensorTests: { [testKey]: null } })}>
                      Poista
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy} data-testid="sb-test-clear-all" onClick={() => send({ sensorTestsClear: true })}>
                      Tyhjennä kaikki
                    </Button>
                  </div>
                  {overrides.size > 0 && (
                    <div className="text-xs text-fuchsia-200">Aktiiviset: {[...overrides].join(", ")}</div>
                  )}
                </div>
              )}
              {ackMsg && <div className="mt-2 rounded border border-border bg-black/30 px-2 py-1 text-xs" data-testid="sb-ack">{ackMsg}</div>}
            </Section>
          )}

          {tab === "puhallin" && (
            <Section title="Puhallin (FanDutyPercent)">
              {!canCmd ? (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100" data-testid="sb-no-cmd-fan">
                  ei tue komentoja
                </div>
              ) : (
                <div className="space-y-3">
                  {item?.testMode && (
                    <div className="rounded border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-1 text-xs text-fuchsia-100" data-testid="sb-testmode-warn">
                      TestMode=true: fyysiset lähdöt pois päältä — FanDutyPercent saa usein virheen <b>outputs</b>.
                    </div>
                  )}
                  {item?.controlWord?.some((b) => b.name === "Fan" && b.on) ? null : (
                    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-100" data-testid="sb-fan-warn">
                      ControlWord.Fan = off — laite voi vastata error:outputs
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={fanPct}
                      onChange={(e) => setFanPct(Number(e.target.value))}
                      className="flex-1"
                      data-testid="sb-fan-slider"
                    />
                    <span className="w-12 tabular-nums text-sm">{fanPct} %</span>
                    <Button size="sm" disabled={busy} data-testid="sb-fan-send" onClick={() => send({ FanDutyPercent: fanPct })}>
                      Lähetä
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Nykyinen duty {item?.fanDutyPercent ?? "—"} % · PWM {item?.fanPwm ?? "—"} · req {item?.fanRequestedPercent ?? "—"} %
                  </div>
                </div>
              )}
              {ackMsg && <div className="mt-2 rounded border border-border bg-black/30 px-2 py-1 text-xs" data-testid="sb-ack">{ackMsg}</div>}
            </Section>
          )}
          {tab === "asetukset" && (
            <Section
              title="Asetukset (Schema ≥ 5)"
              right={
                settingsOverridden.length > 0 ? (
                  <Badge kind="test">ASETUS OHITETTU (RAM): {settingsOverridden.join(", ")}</Badge>
                ) : null
              }
            >
              {!canSettings ? (
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100" data-testid="sb-no-settings">
                  asetukset/restart vaativat Schema ≥ 5 {item?.schema != null ? `(nyt ${item.schema})` : ""}
                </div>
              ) : (
                <div className="space-y-4" data-testid="sb-asetukset">
                  <div className="rounded border border-border bg-black/20 px-3 py-2 text-xs text-muted-foreground">
                    <div>TestMode: <b className={item?.testMode ? "text-fuchsia-300" : "text-emerald-300"}>{item?.testMode ? "true" : "false"}</b>
                      {item?.testMode ? " — fyysiset lähdöt (fan/heat) estetty → FanDuty → outputs" : ""}
                    </div>
                    {settingsOverridden.length > 0 && (
                      <div className="mt-1 text-fuchsia-200">SettingsOverridden: {settingsOverridden.join(", ")}</div>
                    )}
                  </div>

                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">ControlWord</div>
                    <div className="flex flex-wrap gap-3">
                      {CW_BITS.map(({ bit, name }) => {
                        const on = Boolean(cwDraft & (1 << bit));
                        return (
                          <label key={name} className="flex items-center gap-1.5 text-xs" data-testid={`sb-cw-bit-${name}`}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleCwBit(bit)}
                              disabled={busy}
                            />
                            <span className={on ? "text-emerald-300" : "text-muted-foreground"}>{name}<span className="text-[10px] opacity-60"> b{bit}</span></span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <label className="text-xs">
                        uint16
                        <input
                          type="number"
                          min={0}
                          max={65535}
                          value={cwDraft}
                          onChange={(e) => setCwDraft(Math.max(0, Math.min(65535, Number(e.target.value) || 0)))}
                          className="mt-1 block h-9 w-28 rounded border border-input bg-background px-2 tabular-nums"
                          data-testid="sb-cw-raw"
                          disabled={busy}
                        />
                      </label>
                      <Button
                        size="sm"
                        disabled={busy}
                        data-testid="sb-cw-send"
                        onClick={() => send({ settings: { ControlWord: cwDraft } })}
                      >
                        Lähetä ControlWord
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        data-testid="sb-settings-clear"
                        onClick={() => send({ settingsClear: true })}
                      >
                        Palauta
                      </Button>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Nykyinen telemetria: ControlWord={String(item?.values?.ControlWord ?? "—")} · RAM-ohitukset tyhjennetään &quot;Palauta&quot;-painikkeella tai restartilla.
                    </p>
                  </div>

                  <div className="border-t border-border pt-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Uudelleenkäynnistys</div>
                    <p className="mb-2 text-[11px] text-amber-100/90">
                      Restart tyhjentää sensorTests-overridet, settings-ohitukset (RAM) ja puhallinasetuksen (FanDuty).
                    </p>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      data-testid="sb-restart"
                      onClick={() => setRestartOpen(true)}
                    >
                      Restart
                    </Button>
                    {restartStatus && (
                      <div className="mt-2 text-xs" data-testid="sb-restart-status">{restartStatus}</div>
                    )}
                  </div>
                </div>
              )}
              {ackMsg && <div className="mt-2 rounded border border-border bg-black/30 px-2 py-1 text-xs" data-testid="sb-ack">{ackMsg}</div>}
            </Section>
          )}

        </div>
      </DialogContent>
    </Dialog>

    {restartOpen && (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"
        data-testid="sb-restart-confirm"
        role="alertdialog"
        aria-modal="true"
      >
        <div className="max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
          <h3 className="mb-2 text-sm font-semibold">Käynnistetäänkö {dev} uudelleen?</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Restart tyhjentää sensorTests-overridet, settings-ohitukset (RAM) ja puhallinasetuksen.
            Lähetetään {"{"}&quot;restart&quot;:true,&quot;confirm&quot;:&quot;{dev}&quot;{"}"}.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRestartOpen(false)} disabled={busy}>Peruuta</Button>
            <Button size="sm" variant="destructive" data-testid="sb-restart-yes" onClick={() => void doRestart()} disabled={busy}>
              Käynnistä uudelleen
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}



/** Dashboard-widgetti: kompaktin kortin klikkaus avaa faceplaten (kuten Mittauspiste). */
export function SensorBlockWidget({ config }: { config: { device?: string } }) {
  const { items, devices, load } = useSensorBlocks(4000);
  const [open, setOpen] = useState(false);
  const preferred = config.device;
  const item =
    (preferred && items.find((i) => i.device === preferred)) ||
    items[0] ||
    null;
  const sel = item?.device ?? preferred ?? devices[0];

  if (!item) {
    return (
      <div className="flex h-full flex-col justify-center gap-1 p-3 text-xs text-muted-foreground" data-testid="sb-widget-empty">
        <div className="font-mono text-sm text-foreground">SensorBlock</div>
        <div>Ei telemetriaa vielä…</div>
        <button type="button" className="text-sky-400 underline" onClick={() => void load()}>Päivitä</button>
      </div>
    );
  }

  return (
    <>
      <div className="h-full p-1" data-testid="sb-widget">
        <SensorBlockCard item={item} onOpen={() => setOpen(true)} />
      </div>
      <SensorBlockFaceplate
        open={open}
        onClose={() => setOpen(false)}
        initialDevice={sel}
        devices={devices.length ? devices : items.map((i) => i.device)}
      />
    </>
  );
}

export function SensorBlockPanel() {
  const { items, devices, load } = useSensorBlocks(4000);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string | undefined>();
  return (
    <Card className="p-4 bg-card border-border" data-testid="sb-panel">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-mono uppercase text-muted-foreground">SensorBlock</h2>
        <Button size="sm" variant="secondary" onClick={() => void load()}>Päivitä</Button>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {items.map((it) => (
          <SensorBlockCard
            key={it.device}
            item={it}
            onOpen={() => {
              setSel(it.device);
              setOpen(true);
            }}
          />
        ))}
        {!items.length && <div className="text-xs text-muted-foreground italic">Ei laitteita / dataa.</div>}
      </div>
      <SensorBlockFaceplate
        open={open}
        onClose={() => setOpen(false)}
        initialDevice={sel}
        devices={devices.length ? devices : items.map((i) => i.device)}
      />
    </Card>
  );
}
