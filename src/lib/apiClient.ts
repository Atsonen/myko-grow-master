import type {
  EnvironmentReading,
  MEvent,
  Strain,
  Transfer,
  Unit,
  UnitLocationRecord,
} from "@/types";
import type { Taxonomy, PersistedMykoState } from "@/store/useDataStore";

export interface StateSummary {
  ok: boolean;
  source: "mariadb";
  counts: {
    strains: number;
    units: number;
    events: number;
    transfers: number;
  };
}

export type ImportMode = "upsert" | "replace";

export type TrendMetric = "temperatureC" | "humidityRh" | "co2Ppm";
export type TrendBucket = "raw" | "5m" | "10m" | "30m" | "hour" | "6h" | "day";

export interface TrendVariable {
  id: string;
  source: "environment_readings" | "datalogger_values";
  location: string;
  metric: TrendMetric | string;
  prefix?: string;
  label: string;
  unit: string;
  sampleCount: number;
  from?: string;
  to?: string;
  min?: number;
  max?: number;
  avg?: number;
}

export interface TrendPoint {
  timestamp: string;
  value: number;
  min?: number;
  max?: number;
  sampleCount?: number;
  bucket: TrendBucket;
}

export interface TrendWidgetConfig {
  id: string;
  title: string;
  variableId?: string;
  variableIds?: string[];
  range: "1h" | "6h" | "24h" | "7d" | "30d" | "custom";
  from?: string;
  to?: string;
  bucket: TrendBucket;
  chartType: "line" | "area";
  /** Widget overrides: per-series display name/color/axis, per-axis min/max. */
  series?: Record<string, { name?: string; color?: string; axis?: "auto" | "left" | "right" }>;
  axes?: { left?: { min?: number | null; max?: number | null }; right?: { min?: number | null; max?: number | null } };
}

export interface TrendLayout {
  widgets: TrendWidgetConfig[];
}

export interface TrendPreset {
  id: string;
  viewKey: WorkspaceKey;
  name: string;
  layout: TrendLayout;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceKey = "myko" | "plants";

export interface DataloggerVariable {
  sourceId: string;
  position: number;
  variableKey: string;
  prefix: string;
  name: string;
  unit: string;
  scale: number;
  visible: boolean;
  /** analog = trendable value, status = bit word, unused = free/placeholder index */
  type: DataloggerVariableType;
  displayName?: string;
  bits: StatusBitDef[];
  archived: boolean;
  description?: string;
}

export type DataloggerVariableType = "analog" | "status" | "unused";

export interface StatusBitDef {
  bit: number;
  name: string;
  onColor?: string;
  offColor?: string;
  invert?: boolean;
  alarm?: boolean;
}

export type DataloggerVariablePatch = Partial<
  Pick<DataloggerVariable, "prefix" | "scale" | "unit" | "visible" | "type" | "bits">
> & { displayName?: string | null };

export interface DataloggerLatest {
  variableKey: string;
  raw: number | null;
  value: number | null;
  timestamp: string | null;
}

export async function getDataloggerLatest(keys: string[]) {
  return requestJson<DataloggerLatest[]>(`/api/datalogger/latest?keys=${encodeURIComponent(keys.join(","))}`);
}

export async function getStateSummary() {
  return requestJson<StateSummary>("/api/state/summary");
}

export async function getStrains() {
  return requestJson<Strain[]>("/api/strains");
}

export async function getStrain(code: string) {
  return requestJson<Strain>(`/api/strains/${encodeURIComponent(code)}`);
}

export async function createStrain(payload: Strain) {
  return requestJson<Strain>("/api/strains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateStrain(originalCode: string, payload: Strain) {
  return requestJson<Strain>(`/api/strains/${encodeURIComponent(originalCode)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function getUnits() {
  return requestJson<Unit[]>("/api/units");
}

export async function getUnit(code: string) {
  return requestJson<Unit>(`/api/units/${encodeURIComponent(code)}`);
}

export async function createUnit(payload: Omit<Unit, "id">) {
  return requestJson<Unit>("/api/units", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateUnit(code: string, payload: Unit) {
  return requestJson<Unit>(`/api/units/${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function archiveUnits(unitCodes: string[]) {
  return requestJson<{ ok: boolean; counts: { units: number; events: number } }>(
    "/api/units/archive",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitCodes }),
    },
  );
}

export async function getEvents() {
  return requestJson<MEvent[]>("/api/events");
}

export async function getTransfers() {
  return requestJson<Transfer[]>("/api/transfers");
}

export async function getTaxonomy() {
  return requestJson<Taxonomy & { locations?: string[]; substrates?: string[] }>("/api/taxonomy");
}

export async function getDbState() {
  return requestJson<PersistedMykoState>("/api/state");
}

export async function getLatestEnvironmentReadings() {
  return requestJson<EnvironmentReading[]>("/api/environment/latest");
}

export async function getTrendVariables() {
  return requestJson<TrendVariable[]>("/api/trends/variables");
}

export async function getTrendSeries(params: {
  variableId: string;
  from: string;
  to: string;
  bucket: TrendBucket;
}) {
  const search = new URLSearchParams({
    variableId: params.variableId,
    from: params.from,
    to: params.to,
    bucket: params.bucket,
  });
  return requestJson<TrendPoint[]>(`/api/trends/series?${search.toString()}`);
}

export async function getTrendPresets(viewKey: WorkspaceKey = "myko") {
  const search = new URLSearchParams({ viewKey });
  return requestJson<TrendPreset[]>(`/api/trends/presets?${search.toString()}`);
}

export async function getDataloggerVariables() {
  return requestJson<DataloggerVariable[]>("/api/datalogger/variables");
}

export async function updateDataloggerVariable(
  sourceId: string,
  variableKey: string,
  payload: DataloggerVariablePatch,
) {
  return requestJson<DataloggerVariable>(
    `/api/datalogger/variables/${encodeURIComponent(sourceId)}/${encodeURIComponent(variableKey)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function saveTrendPreset(
  payload: Pick<TrendPreset, "id" | "viewKey" | "name" | "layout">,
) {
  return requestJson<TrendPreset>("/api/trends/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteTrendPreset(id: string) {
  return requestJson<{ ok: boolean }>(`/api/trends/presets/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function getUnitLocations() {
  return requestJson<UnitLocationRecord[]>("/api/unit-locations");
}

export async function saveUnitLocation(payload: Omit<UnitLocationRecord, "id">) {
  return requestJson<{ id: number }>("/api/unit-locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function saveEnvironmentReading(payload: Omit<EnvironmentReading, "id">) {
  return requestJson<{ id: number }>("/api/environment/readings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function importStateToDb(payload: unknown, mode: ImportMode) {
  return requestJson<{
    ok: boolean;
    mode: ImportMode;
    counts: StateSummary["counts"] & { taxonomyTerms: number };
  }>(`/api/state/import?mode=${encodeURIComponent(mode)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(url), {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json() as Promise<T>;
}

function resolveApiUrl(url: string) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
  return baseUrl && url.startsWith("/") ? `${baseUrl}${url}` : url;
}

async function readApiError(response: Response) {
  try {
    const payload = await response.json();
    return payload.error || response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function getUnitLocationHistory(unitCode: string) {
  return requestJson<UnitLocationRecord[]>(
    `/api/unit-locations?unitCode=${encodeURIComponent(unitCode)}`,
  );
}

export async function moveUnit(payload: {
  unitCode: string;
  location: string;
  movedAt?: string;
  note?: string;
}) {
  return requestJson<UnitLocationRecord>("/api/unit-locations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function archiveUnitLocation(id: number | string) {
  return requestJson<{ ok: boolean; unitCode: string; currentLocation: string | null }>(
    `/api/unit-locations/${encodeURIComponent(String(id))}/archive`,
    { method: "POST" },
  );
}

export interface UnitEnvironmentPoint {
  timestamp: string;
  location: string;
  temperatureC: number | null;
  temperatureMin: number | null;
  temperatureMax: number | null;
  humidityRh: number | null;
}

export interface UnitEnvironment {
  unitCode: string;
  from: string;
  to: string;
  ended: boolean;
  bucketSeconds: number;
  periods: { location: string; from: string; to: string; assumed: boolean }[];
  moves: UnitLocationRecord[];
  points: UnitEnvironmentPoint[];
}

export async function getUnitEnvironment(unitCode: string, points = 400) {
  return requestJson<UnitEnvironment>(
    `/api/units/${encodeURIComponent(unitCode)}/environment?points=${points}`,
  );
}

export async function getDashboardLayout<T = unknown>(id?: string) {
  return requestJson<{ id: string; layout: T | null; updatedAt: string | null }>(`/api/dashboard/layout${id ? `?id=${encodeURIComponent(id)}` : ""}`);
}

export async function saveDashboardLayout<T = unknown>(layout: T, id?: string) {
  return requestJson<{ id: string; layout: T }>(`/api/dashboard/layout${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout }),
  });
}

export async function resetDashboardLayout(id?: string) {
  return requestJson<{ ok: boolean }>(`/api/dashboard/layout${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" });
}

export type SequenceSettings = { enable: boolean; t_circ_s: number; t_settle_s: number; t_fill_s: number; plc_write: false; hb_enabled: false };
export type SequenceResponse = {
  settings: SequenceSettings; present: boolean; stale: boolean; plc_at: string | null; steps: Record<string, string>;
  write_allowed: boolean; write_note: string; pump_write_allowed?: boolean;
  plc: { present?: boolean; Step?: number; StepTime_ms?: number; HB_OK?: boolean; Stopped?: boolean; CycleCount?: number;
    Enable?: boolean; LeakAlarm?: boolean; T_Circ?: number; T_Settle?: number; T_Fill?: number; Level?: number;
    L_Pump?: boolean; L_Running?: boolean; L_Error?: boolean; L_Enable?: boolean; L_Done?: boolean; L_Status?: number;
    R_Pump?: boolean; R_Running?: boolean; R_Error?: boolean; R_Enable?: boolean; R_Done?: boolean; R_Status?: number };
};
export async function getSequence() { return requestJson<SequenceResponse>("/api/sequence"); }
export async function setCircPumpEnable(side: "L" | "R", enable: boolean) {
  return requestJson<{ ok: boolean; key: string; value: boolean; read?: boolean }>("/api/sequence/pump", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ side, enable }) });
}
export async function putSequence(s: Partial<SequenceSettings>) {
  return requestJson<{ settings: SequenceSettings; written_to_plc: false }>("/api/sequence", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
}

export interface SeriesStyleDefault {
  name?: string;
  color?: string;
  axis?: "left" | "right";
}

export async function getSeriesDefaults() {
  return requestJson<{ series: Record<string, SeriesStyleDefault> }>("/api/trends/series-defaults");
}

export async function saveSeriesDefaults(series: Record<string, SeriesStyleDefault>) {
  return requestJson<{ series: Record<string, SeriesStyleDefault> }>("/api/trends/series-defaults", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ series }),
  });
}

export interface AlarmBitDef {
  bit: number;
  key: string;
  level: "warn" | "alarm";
  rule: string;
}

export interface AlarmPoint {
  id: string;
  name: string;
  topicPrefix: string;
  valueSource?: string;
  unit: string;
  bits: AlarmBitDef[];
  status: number | null;
  active: string[];
  since: Record<string, string | null>;
  alarmValue: number | null;
  lastReading: string | null;
  checked: string | null;
  lastMessageAt: string | null;
  current: { value: number; timestamp: string } | null;
  controls: AlarmControls | null;
}

export interface AlarmControls {
  on: boolean;
  heat: boolean;
  cool: boolean;
  setpoint: number;
  limits: AlarmLimits;
  /** ISO UTC; null when alarms are enabled */
  alarmsDisabledUntil: string | null;
  updatedBy?: string;
  updatedAt?: string;
}

/** Relative to setpoint: WARN ±/+warnDelta for warnMin, HIGH +highDelta for highMin, LOW -lowDelta for lowMin. */
export interface AlarmLimits {
  warnDelta: number;
  warnMin: number;
  warnBoth: boolean;
  highDelta: number;
  highMin: number;
  lowDelta: number;
  lowMin: number;
}

export type AlarmControlsPatch = Partial<Pick<AlarmControls, "on" | "heat" | "cool" | "setpoint">> & {
  limits?: Partial<AlarmLimits>;
  /** 1..1440 disables alarms for that many minutes, 0 re-enables now */
  disableMinutes?: number;
};

export async function setAlarmControls(pointId: string, patch: AlarmControlsPatch) {
  return requestJson<{ controls: AlarmControls; word: number | null; published: boolean; publishError?: string }>(
    `/api/alarms/${encodeURIComponent(pointId)}/controls`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) },
  );
}

export interface AlarmEvent {
  id: number;
  alarm: string;
  bit: number | null;
  event: "start" | "clear" | "control";
  at: string;
  value: number | null;
  statusWord: number | null;
}

export async function getAlarmPoints() {
  return requestJson<AlarmPoint[]>("/api/alarms/points");
}

export async function getAlarmEvents(pointId: string, limit = 20) {
  return requestJson<AlarmEvent[]>(`/api/alarms/${encodeURIComponent(pointId)}/events?limit=${limit}`);
}

export interface AlarmSummaryRow {
  id: number;
  pointId: string;
  pointName: string;
  unit: string;
  alarm: string;
  bit: number | null;
  /** 1 = alarm (red square), 2 = warning (yellow triangle) */
  priority: 1 | 2;
  start: string;
  end: string | null;
  active: boolean;
  value: number | null;
  endValue: number | null;
  durationSec: number;
  source?: "PLC" | "Myko" | "LLM" | "Kasvamo";
  /** short Finnish description (rule text / DeepSeek finding) */
  desc?: string;
  acked?: boolean;
  ackedAt?: string | null;
  ackedBy?: string | null;
  disabledUntil?: string; disableKind?: "fert" | "kasvamo"; disableKey?: string;
}
export interface AlarmSummary {
  hours: number;
  generatedAt: string;
  points: { id: string; name: string; source?: "PLC" | "Myko" | "Kasvamo" }[];
  rows: AlarmSummaryRow[];
  plc?: { key: string; pointId: string; errBits: number | null; err: boolean | null; warn: number | null; at: string | null }[];
}
export type AlarmAckResult = { requested: number; dryRun?: boolean; acked: { id: number; pointId: string; alarm: string }[]; skipped: { id: number; reason: string }[] };
/** Myko alarm-list acknowledgment (not PLC ErrorAck). */
export async function ackAlarms(ids: number[], dryRun = false) {
  return requestJson<AlarmAckResult>("/api/alarms/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, by: "dashboard", dryRun }) });
}
/** PLC ErrorAck to all PIDs (bridge) + Myko ack of the mirrored ERRORBITS/PID_VIKA alarms. */
export async function plcErrorAckAll(dryRun = false) {
  return requestJson<{ dryRun: boolean; pids: { key: string; error?: string | null }[]; mykoAck: AlarmAckResult; error?: string }>("/api/plc/error-ack", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun }),
  });
}
export interface AlarmDetailEvent { id: number; pointId: string; pointName: string; alarm: string; event: string; at: string; value: number | null; desc: string }
export interface AlarmDetailLlm { id: number; at: string; severity: string; point: string; category: string; finding: string; suggestion: string; duplicate: boolean }
export interface AlarmDetailIncident {
  id: number; ts_start: string; ts_end: string | null; duration_s: number | null; alarm: string | null; device: string | null; status: string;
  resolved_by: string | null; signature: string | null; episodes: number; symptom: string; resolution: string | null; this_alarm: boolean; n_actions: number; actions_txt: string | null;
}
export interface AlarmDetail {
  kind: "alarm" | "llm"; id: number; pointId?: string; pointName: string; unit?: string; alarm: string; bit?: number | null;
  desc: string; rule?: string | null; threshold?: string | null; level?: string | null; priority?: 1 | 2; source: "PLC" | "Myko" | "LLM";
  start: string; end?: string | null; active?: boolean; durationSec?: number; value?: number | null; endValue?: number | null; statusWord?: number | null;
  acked?: boolean; ackedAt?: string | null; ackedBy?: string | null;
  pid?: { key: string; at: string; sp: number | null; pv: number | null; outHeat: number | null; outCool: number | null; state: number | null; live: boolean } | null;
  finding?: string; suggestion?: string; severity?: string; category?: string; point?: string; trigger?: string; recommendReset?: boolean; whatsapp?: boolean | null;
  related: AlarmDetailEvent[]; relatedLlm: AlarmDetailLlm[]; incidents?: AlarmDetailIncident[];
}
export async function getAlarmDetail(id: number) {
  return requestJson<AlarmDetail>(`/api/alarms/detail/${id}`);
}
export async function getAlarmSummary(hours = 24, limit = 500) {
  return requestJson<AlarmSummary>(`/api/alarms/summary?hours=${hours}&limit=${limit}`);
}

/** OPC UA PID (PID_Temp) state from opcua-bridge (MQTT Sensors/PLC_2/<key>_PID), short keys. */
export interface PidValues {
  SP: number; PV: number; CSP: number; Dist: number; ScPV: number;
  OutHeat: number; OutCool: number; OutSum: number;
  ManEn: boolean; ManVal: number; State: number; Mode: number;
  Err: boolean; ErrBits: number; Warn: number;
  SPLimH: boolean; SPLimL: boolean; PVWarnH: boolean; PVWarnL: boolean;
  DisCool: boolean; ActCool: boolean; InHi: number; InLo: number;
  HGain: number; HTi: number; HTd: number; HCyc: number;
  CGain: number; CTi: number; CTd: number; CCyc: number;
  HDZ: number; CDZ: number; Prog: number; HEnTune: boolean; CEnTune: boolean;
  SUTSt: number; TIRSt: number; SUTHOk: boolean; SUTCOk: boolean;
}
export interface PidStatus {
  key: string; pointId: string; alarmPointId: string; at: string | null; values: Partial<PidValues> | null;
  /** active PID alarm keys from the backend evaluator (EI_AUTO, PID_VIKA, ERRORBITS, OPCUA, SATUROITUNUT) */
  active: string[]; intended: boolean; tuning?: boolean;
  trend?: { t: number; pv?: number; sp?: number; out?: number }[];
  commands: { alarm: string; at: string }[];
}
export type PidCommand = { ManualEnable?: boolean; ManualValue?: number; Mode?: 0 | 1 | 2 | 3 | 4; ModeActivate?: true; ErrorAck?: true; HeatEnableTuning?: boolean; CoolEnableTuning?: boolean };
export async function getPid(key: string, trend = false) {
  return requestJson<PidStatus>(`/api/pid/${encodeURIComponent(key)}${trend ? "?trend=1" : ""}`);
}
export async function sendPidCommand(key: string, cmd: PidCommand) {
  return requestJson<{ id: string; results?: Record<string, unknown>; error?: string }>(`/api/pid/${encodeURIComponent(key)}/cmd`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd),
  });
}

export type PvFeed = {
  topic: string | null; field: string | null; enabled: boolean; min: number; max: number; maxStep: number; confirmN: number; faultS: number; staleS: number;
  lastRaw: number | null; rawAt: number | null; lastGood: number | null; goodAt: number | null; reject: string | null; rejectAt: number | null;
  wrote: number | null; wroteAt: number | null; writes: number; writeErr: string | null; plcInput: number | null; alarms: { SENSOR_VIKA?: boolean; INPUT_STALE?: boolean; ANTURIVIKA_ALASAJO?: boolean };
  shutdownMin: number; faultSince: number | null; shutdown: boolean; onState: boolean | null;
};
export type PvFeedResponse = { key: string; feed: PvFeed; codes?: Record<string, string>; sources?: { topic: string; field: string; value: number; at: string; label?: string; dl?: string }[]; restricted?: boolean };
export type PumputResponse = { at: string | null; stale: boolean; values: Record<string, number | boolean> };
export type KasLimit = { lo: number | null; hi: number | null; hyst: number; enabled: boolean; disabled_until?: string; disable_min?: number };
export type KasvamoAlarms = { config: { enabled: boolean; delay_min: number; stale_min: number; limits: Record<string, KasLimit> }; active: Record<string, boolean>; acked?: Record<string, string>; ids?: Record<string, number>;
  signals: Record<string, { dl: string; name: string; unit: string; range: [number, number] }> };
export async function getKasvamoAlarms() { return requestJson<KasvamoAlarms>("/api/kasvamo/alarms"); }
export async function putKasvamoAlarms(body: { delay_min?: number; enabled?: boolean; disable_min?: number; limits?: Record<string, Partial<KasLimit>> }) {
  return requestJson<KasvamoAlarms>("/api/kasvamo/alarms", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export async function getPumput() {
  return requestJson<PumputResponse>("/api/pumput");
}
export async function getPvFeed(key: string) {
  return requestJson<PvFeedResponse>(`/api/pid/${encodeURIComponent(key)}/feed`);
}
export async function setPvFeed(key: string, body: Partial<Pick<PvFeed, "topic" | "field" | "enabled" | "min" | "max" | "shutdownMin">>) {
  return requestJson<PvFeedResponse>(`/api/pid/${encodeURIComponent(key)}/feed`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

// ---- DeepSeek PID advisor ----
export type PidAiResponse = { assessment?: string; issues?: string[]; proposed_params?: Record<string, number>; rationale?: string; risk?: string; confidence?: number; dropped_params?: string[] };
export type PidAiAnalysis = { id: number; at: string; trigger: string; model: string; status: string; tokens: { prompt: number | null; completion: number | null }; params: Record<string, number | string | boolean> | null; response: PidAiResponse | null; wishes?: string | null };
export type PidParamHist = { id: number; at: string; kind: string; by_user: string | null; reason: string | null; params: Record<string, number> | null; result: { results?: Record<string, { before: number; read: number; ok: boolean }> } | null };
export type PidAiState = { key: string; analyses: PidAiAnalysis[]; history: PidParamHist[]; hasNew: boolean; canRestore: boolean; limits: Record<string, [number, number]>; maxRelChange: number; rateMin: number };
export type PidAiJob = { id: string; status: "running" | "done" | "error"; error?: string; result?: { id?: number; ok?: boolean; results?: Record<string, { before: number; wrote: number; read: number; ok: boolean }> } };
const aiUrl = (key: string, p: string) => `/api/pid/${encodeURIComponent(key)}/${p}`;
const post = (body?: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
export const getPidAi = (key: string) => requestJson<PidAiState>(aiUrl(key, "ai-analysis"));
export const startPidAiAnalyze = (key: string, wishes?: string) => requestJson<PidAiJob>(aiUrl(key, "ai-analyze"), post({ wishes: wishes || undefined }));
export const getPidAiJob = (key: string, id: string) => requestJson<PidAiJob>(aiUrl(key, `ai-job/${id}`));
export const markPidAiSeen = (key: string) => requestJson<{ ok: boolean }>(aiUrl(key, "ai-seen"), post());
export const startPidAiApply = (key: string, analysisId: number, params: Record<string, number>, confirmLarge: boolean) =>
  requestJson<PidAiJob>(aiUrl(key, "ai-apply"), post({ analysisId, params, confirmLarge }));
export const startPidAiRestore = (key: string) => requestJson<PidAiJob>(aiUrl(key, "ai-restore"), post());
export const startPidParamsApply = (key: string, params: Record<string, number>, confirmLarge: boolean) =>
  requestJson<PidAiJob>(aiUrl(key, "params-apply"), post({ params, confirmLarge }));
export type FertEcAlarm = { disabled_until?: string; enabled: boolean; lo_off: number; hi_off: number; warn_lo_off: number; warn_hi_off: number; hyst: number; delay_min: number };
export type FertEvent = { id?: number; code?: string; level: "alarm" | "warning"; text: string; ts?: string; since?: string; cleared_ts?: string | null; active?: boolean; acked?: boolean; acked_ts?: string | null; acked_by?: string | null };
export type FertDoseStatus = { mode: string; heartbeat: string; hbValue: number; interlock: boolean; pump_write_allowed?: boolean;
  config: { live: boolean; hb_enabled: boolean; plc_enable: boolean; auto: boolean; fert: string; dose_s: number; ec_sp?: number; below_min: number; pause_min: number; ec_alarm: FertEcAlarm };
  plc: { present: boolean; fresh: boolean; statusText: string | null; Status?: number; Enable?: boolean; HB_OK?: boolean; DoseActive?: boolean; DoseCount?: number; LastDose_ms?: number; RunTime_ms?: number; Heartbeat?: number; Pump?: boolean };
  ec: { value: number; at: string } | null; sp: number | null; belowSince: string | null; lastDoseAt: string | null; nextAllowedAt: string | null; reason: string;
  active: FertEvent[]; events: FertEvent[];
  cumulative: { fert: string; mode: string; n: number; req_ms: number; act_ms: number }[];
  recent: { ts: string; fert: string; requested_ms: number; actual_ms: number | null; ec_before?: number | null; ec_sp?: number | null; mode: string; reason: string }[];
  reliable?: { ok: boolean; why: string | null }; spPlc?: number | null; validSince?: string | null; trend?: [number, number][] };
export async function postFertDose() {
  return requestJson<{ ok: boolean; mode?: string; error?: string }>("/api/fertdose/dose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
}
export async function getFertDose() { return requestJson<FertDoseStatus>("/api/fertdose"); }
/** Prosessinäkymä: lannoitepumpun Käyttö (FB_FertDose_DB.Input.Enable). */
export async function setFertPumpEnable(enable: boolean) {
  return requestJson<{ ok: boolean; enable: boolean; written: boolean; read?: boolean; interlock?: boolean }>("/api/fertdose/pump", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enable }) });
}
export async function putFertDoseSettings(body: Record<string, unknown>) {
  return requestJson<{ config: FertDoseStatus["config"] }>("/api/fertdose/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}


export type SensorBlockDecoded = { kind: string; text: string; value?: number | boolean | string; unit?: string; code?: number; disabled?: boolean };
export type SensorBlockItem = {
  device: string;
  at: string | null;
  ageMs: number | null;
  stale: boolean;
  values: Record<string, unknown> | null;
  schema: number | null;
  commandsSupported: boolean;
  controlWord: { name: string; bit: number; on: boolean }[];
  sensorTests: unknown[];
  hasActiveTests?: boolean;
  testMode: boolean;
  decoded: Record<string, SensorBlockDecoded>;
  heat?: boolean;
  heatRequested?: boolean;
  fanRequestedPercent?: number;
  fanDutyPercent?: number;
  fanPwm?: number;
  status?: number;
  rssi?: number;
  uptime?: number;
};
export type SensorBlockListResponse = { devices: string[]; items: SensorBlockItem[] };
export async function getSensorBlocks() {
  return requestJson<SensorBlockListResponse>("/api/sensorblock");
}
export async function getSensorBlock(dev: string) {
  return requestJson<SensorBlockItem>(`/api/sensorblock/${encodeURIComponent(dev)}`);
}
export async function getSensorBlockConfig() {
  return requestJson<{ devices: string[] }>("/api/sensorblock/config");
}
export async function putSensorBlockConfig(devices: string[]) {
  return requestJson<{ devices: string[] }>("/api/sensorblock/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices }),
  });
}
export async function postSensorBlockCommand(dev: string, body: Record<string, unknown>) {
  return requestJson<{ ok: boolean; ack?: unknown; error?: string }>(
    `/api/sensorblock/${encodeURIComponent(dev)}/command`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}
