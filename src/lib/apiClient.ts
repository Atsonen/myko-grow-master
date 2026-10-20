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
export type TrendBucket = "raw" | "hour" | "day";

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
  archived: boolean;
  description?: string;
}

export type DataloggerVariablePatch = Pick<
  DataloggerVariable,
  "prefix" | "scale" | "unit" | "visible"
>;

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
  return requestJson<Taxonomy>("/api/taxonomy");
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

export async function getDashboardLayout<T = unknown>() {
  return requestJson<{ id: string; layout: T | null; updatedAt: string | null }>("/api/dashboard/layout");
}

export async function saveDashboardLayout<T = unknown>(layout: T) {
  return requestJson<{ id: string; layout: T }>("/api/dashboard/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout }),
  });
}

export async function resetDashboardLayout() {
  return requestJson<{ ok: boolean }>("/api/dashboard/layout", { method: "DELETE" });
}
