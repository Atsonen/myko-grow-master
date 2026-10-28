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
  const [tab, setTab] = useState<"tele" | "testit" | "puhallin">("tele");
  const [hideDisabled, setHideDisabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ackMsg, setAckMsg] = useState<string | null>(null);
  const [testKey, setTestKey] = useState<string>("Tds");
  const [testVal, setTestVal] = useState("1500");
  const [fanPct, setFanPct] = useState(0);

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

  const ackLabel = (err?: string) => {
    const map: Record<string, string> = {
      outputs: "laitteen lähdöt hylkäsivät (outputs) — tarkista Fan/Heating ControlWord",
      sensor_tests: "sensorTests hylätty",
      no_fields: "ei kenttiä",
      invalid_json: "virheellinen JSON",
      timeout: "timeout",
    };
    return err ? (map[err] ?? err) : "virhe";
  };
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setAckMsg(null);
    try {
      const r = await postSensorBlockCommand(dev, body);
      if (r.ok) {
        setAckMsg(`OK ${JSON.stringify(r.ack ?? {})}`);
        toast.success("Komento kuitattu");
      } else {
        const m = ackLabel(r.error);
        setAckMsg(`Virhe: ${m} · ${JSON.stringify(r.ack ?? {})}`);
        toast.error(m);
      }
      const fresh = await getSensorBlock(dev);
      setItem(fresh);
    } catch (e) {
      const m = errMsg(e);
      setAckMsg(m);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  return (
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
            {item?.stale ? <Badge kind="warning">Vanha data</Badge> : item ? <Badge kind="ok">Live</Badge> : null}
            <span className="ml-auto text-xs font-normal text-muted-foreground">nähty {ageLabel(item?.ageMs)}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 border-b border-border px-1">
          {([
            ["tele", "Telemetria"],
            ["testit", "Testit"],
            ["puhallin", "Puhallin"],
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
        </div>
      </DialogContent>
    </Dialog>
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
