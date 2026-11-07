// FB_Light faceplate – ryhmäkohtainen valaistus (suomeksi). Ei kirjoituksia mountissa.
import { useCallback, useEffect, useState } from "react";
import { DfBadge, DfKV, DfSection, DfSwitch } from "@/components/DeviceFaceplate";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getLight, setLight, type LightGroupState, type LightResponse } from "@/lib/apiClient";
import { toast } from "sonner";

const POLL_MS = 5000;

export function useLight() {
  const [d, setD] = useState<LightResponse | null>(null);
  const load = useCallback(() => getLight().then(setD).catch(() => undefined), []);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  return { d, load };
}

function modeOptions() {
  return [
    { v: 0, label: "Poissa (0)" },
    { v: 1, label: "Auto (1)" },
    { v: 2, label: "Käsi päälle (2)" },
  ];
}

function statusBadge(g: LightGroupState) {
  if (g.mapping_pending) return <DfBadge kind="muted">OPC odottaa / ei yhteyttä</DfBadge>;
  if (g.stale) return <DfBadge kind="warning">Vanhentunut</DfBadge>;
  if (!g.present) return <DfBadge kind="muted">Ei dataa</DfBadge>;
  if (g.plc.Armed === false && g.plc.Enable) return <DfBadge kind="warning">Ei viritetty</DfBadge>;
  if (g.plc.Ready) return <DfBadge kind="ok">Valmis</DfBadge>;
  return <DfBadge kind="live">Live</DfBadge>;
}

export function LightFaceplate({
  open,
  onOpenChange,
  groupId,
  d,
  reload,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  groupId?: string;
  d: LightResponse | null;
  reload: () => void;
}) {
  const g = d?.groups.find((x) => x.id === groupId) ?? d?.groups[0];
  const [busy, setBusy] = useState(false);
  const writesDisabled = !g || g.stale || g.mapping_pending || !g.write_allowed || !g.present || d?.commissioned === false;

  const write = async (body: Record<string, unknown>, label: string) => {
    if (!g) return;
    if (!window.confirm(`Vahvista: ${label}?`)) return;
    setBusy(true);
    try {
      await setLight(g.id, body);
      toast.success(label);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inp = "w-full rounded border border-border bg-background px-2 py-1 font-mono text-sm";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto font-mono" data-testid="light-faceplate">
        <DialogHeader>
          <DialogTitle className="text-base">
            Valaistus · {g?.label ?? "—"}
            {d?.mapping_pending && (
              <span className="ml-2 text-xs font-normal text-amber-400">(FIXTURE – MQTT-kartoitus odottaa)</span>
            )}
          </DialogTitle>
        </DialogHeader>
        {!g ? (
          <p className="text-sm text-muted-foreground">Ei ryhmiä – täytä myko_settings fb_light.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(g)}
              {g.plc_at && <span className="text-[11px] text-muted-foreground">PLC {new Date(g.plc_at).toLocaleTimeString("fi-FI")}</span>}
            </div>
            {g.mapping_pending && (
              <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                Suora OPC UA backendissä. LIVE kun `FB_LIGHT_OPC_CONNECT=1` ja migrate fb_light ajettu.
                {d?.opc_runtime?.last_error ? ` Virhe: ${d.opc_runtime.last_error}` : ""}
              </p>
            )}
            <DfSection title="Tila">
              <DfKV k="Mode" v={g.mode_label} />
              <DfKV k="Enable" v={g.plc.Enable === true ? "Kyllä" : g.plc.Enable === false ? "Ei" : "—"} />
              <DfKV k="Lähtö" v={g.output.text} cls={g.output.on ? "text-emerald-400" : ""} />
              {g.output.kind === "fb" && (
                <DfKV k="Käsky LightOn" v={g.output.cmd === true ? "ON" : g.output.cmd === false ? "OFF" : "—"} />
              )}
              <DfKV k="Aikataulu (PLC)" v={g.schedule.text} />
              <DfKV k="ScheduleActive" v={g.plc.ScheduleActive === true ? "Kyllä" : g.plc.ScheduleActive === false ? "Ei" : "—"} />
              <DfKV k="LocalHour" v={g.plc.LocalHour ?? "—"} />
              <DfKV k="Armed" v={g.plc.Armed === true ? "Kyllä" : g.plc.Armed === false ? "Ei" : "—"} />
              <DfKV k="HB_OK" v={g.plc.HB_OK === true ? "OK" : g.plc.HB_OK === false ? "PUUTTUU" : "—"} cls={g.plc.HB_OK === false ? "text-red-400" : ""} />
              <DfKV k="ConfigOK" v={String(g.plc.ConfigOK ?? "—")} />
              <DfKV k="ClockOK" v={String(g.plc.ClockOK ?? "—")} />
            </DfSection>
            <DfSection title="Ohjaus (vain käyttäjä)">
              <div className="space-y-2">
                <DfSwitch
                  testid="light-enable"
                  disabled={writesDisabled || busy}
                  on={g.plc.Enable === true}
                  label="Enable"
                  title={writesDisabled ? "Kirjoitus estetty (vanhentunut/ei dataa)" : undefined}
                  onClick={() => void write({ Enable: !g.plc.Enable }, `Enable → ${!g.plc.Enable ? "TRUE" : "FALSE"}`)}
                />
                <label className="block text-xs text-muted-foreground">
                  Mode
                  <select
                    className={`${inp} mt-1`}
                    disabled={writesDisabled || busy}
                    value={g.plc.Mode ?? 0}
                    onChange={(e) => void write({ Mode: Number(e.target.value) }, `Mode → ${e.target.value}`)}
                  >
                    {modeOptions().map((m) => (
                      <option key={m.v} value={m.v}>{m.label}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-muted-foreground">
                    OnHour (0–23)
                    <input
                      className={`${inp} mt-1`}
                      type="number"
                      min={0}
                      max={23}
                      disabled={writesDisabled || busy}
                      defaultValue={g.plc.OnHour ?? 0}
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 0 && n <= 23 && n !== g.plc.OnHour) {
                          void write({ OnHour: n }, `OnHour → ${n}`);
                        }
                      }}
                    />
                  </label>
                  <label className="text-xs text-muted-foreground">
                    OffHour (0–23)
                    <input
                      className={`${inp} mt-1`}
                      type="number"
                      min={0}
                      max={23}
                      disabled={writesDisabled || busy}
                      defaultValue={g.plc.OffHour ?? 0}
                      onBlur={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isInteger(n) && n >= 0 && n <= 23 && n !== g.plc.OffHour) {
                          void write({ OffHour: n }, `OffHour → ${n}`);
                        }
                      }}
                    />
                  </label>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{d?.write_note}</p>
            </DfSection>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Kompakti prosessikuva-merkki vasemmassa yläkulmassa. */
export function LightCompactChip({
  d,
  onOpen,
}: {
  d: LightResponse | null;
  onOpen: () => void;
}) {
  const g = d?.groups[0];
  const unmapped = g?.mapping_pending ?? d?.mapping_pending ?? true;
  const alarm = !unmapped && g && Object.keys(g.alarms?.active ?? {}).length > 0;
  const on = !unmapped && g?.output?.on;
  const stale = !unmapped && g?.stale;
  const fill = unmapped ? "#1e293b" : alarm ? "#4a1d22" : stale ? "#1e293b" : on ? "#052e16" : "#0f172a";
  const stroke = unmapped ? "#64748b" : alarm ? "#ef4444" : stale ? "#64748b" : on ? "#22c55e" : "#475569";
  const label = unmapped ? "EI LIVE" : g?.present ? (g?.output?.on ? "PÄÄLLÄ" : "POIS") : "—";
  return (
    <g
      transform="translate(12,14)"
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      style={{ cursor: "pointer" }}
      role="button"
      data-testid="pd-light-chip"
    >
      <title>
        Valaistus {g?.label ?? ""}: {g?.mode_label ?? "—"} · {g?.schedule?.text ?? ""} – avaa faceplate
        {g?.mapping_pending ? " (MQTT-kartoitus odottaa)" : ""}
      </title>
      <rect width={96} height={46} rx={6} fill={fill} stroke={stroke} strokeWidth={1.5} opacity={stale ? 0.85 : 1} />
      <text x={8} y={14} fontSize={9} fill="#94a3b8" fontFamily="monospace">Valo</text>
      <text x={8} y={30} fontSize={13} fill="#e2e8f0" fontFamily="monospace" fontWeight={700}>{label}</text>
      <text x={8} y={42} fontSize={8} fill="#94a3b8" fontFamily="monospace">
        {unmapped ? "kartoitus puuttuu" : `${(g?.mode_label ?? "—").slice(0, 10)}${g?.plc?.LocalHour != null ? ` · ${g.plc.LocalHour}h` : ""}`}
      </text>
      {alarm && (
        <circle cx={88} cy={8} r={5} fill="#ef4444" />
      )}
    </g>
  );
}

/** Mock-data widget demo / fixture (ei oikeaa PLC:ä). */
export function lightFixtureResponse(): LightResponse {
  const plc = {
    present: true,
    Enable: true,
    HB_OK: true,
    Mode: 1,
    OnHour: 6,
    OffHour: 22,
    LocalHour: 14,
    ClockValid: true,
    LightOn: true,
    ConfigOK: true,
    ClockOK: true,
    ScheduleActive: true,
    Ready: true,
    Armed: true,
  };
  return {
    groups: [{
      id: "kasvamo",
      label: "Kasvamo",
      mapping_pending: true,
      mqtt_sensor: null,
      mqtt_cmd: null,
      plc,
      plc_at: new Date().toISOString(),
      stale: true,
      present: false,
      write_allowed: false,
      schedule: { text: "06:00–22:00 (PLC)", inWindow: true },
      output: { kind: "cmd", on: true, text: "Käsky ON" },
      mode_label: "Auto",
      alarms: { active: {}, texts: {} },
    }],
    config: { groups: [], bridge_note: "fixture" },
    write_note: "FIXTURE – ei kirjoituksia",
    allowed_writes: ["Enable", "Mode", "OnHour", "OffHour"],
    mapping_pending: true,
    stale_ms: 30000,
    startup_grace_s: 60,
  };
}
