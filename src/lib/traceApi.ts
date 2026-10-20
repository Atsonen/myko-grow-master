import { requestJson } from "@/lib/apiClient";

export type OriginType = "UNIT" | "SPORES" | "PURCHASED" | "STRAIN_LIBRARY" | "OTHER" | "UNKNOWN";
export const ORIGIN_TYPES: { value: OriginType; label: string }[] = [
  { value: "UNIT", label: "Parent unit" },
  { value: "SPORES", label: "Spores" },
  { value: "PURCHASED", label: "Purchased culture" },
  { value: "STRAIN_LIBRARY", label: "Strain library" },
  { value: "OTHER", label: "Other" },
  { value: "UNKNOWN", label: "Unknown" },
];
export interface OriginInput { type: OriginType; parentUnitCode?: string; note?: string }
export interface Origin extends OriginInput { id: number; createdAt: string }

export interface TraceNode {
  code: string; depth: number; via: string; type?: string; status?: string; strainCode: string | null;
  effectiveStrainCode: string | null; batchTime: string | null; currentLocation: string | null; hidden: boolean; origins: Origin[];
}
export interface TimelineItem {
  at: string; kind: string; title: string; detail?: string; functionCode?: string; statusChange?: string; operationId?: string;
  actor?: string; before?: Record<string, unknown>; after?: Record<string, unknown>; id: string;
}
export interface EnvPeriod { location: string; from: string; to: string; readings: number; temperatureMin: number | null; temperatureAvg: number | null; temperatureMax: number | null; humidityAvg: number | null }
export interface UnitTrace {
  generatedAt: string;
  unit: Record<string, unknown> & { code: string; origins: Origin[]; effectiveStrainCode: string | null; strainInheritedFrom?: string };
  ancestors: TraceNode[]; descendants: TraceNode[]; edges: { parent: string; child: string }[];
  timeline: TimelineItem[]; environment: { from: string; to: string; periods: EnvPeriod[]; unlocatedNote?: string };
}

const post = <T,>(url: string, body: unknown, method = "POST") =>
  requestJson<T>(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "ui", ...(body as object) }) });

export const getUnitTrace = (code: string) => requestJson<UnitTrace>(`/api/units/${encodeURIComponent(code)}/trace`);
export const setUnitOrigins = (code: string, origins: OriginInput[]) => post(`/api/units/${encodeURIComponent(code)}/origins`, { origins }, "PUT");
export const bulkLocation = (unitCodes: string[], location: string, movedAt?: string, note?: string) =>
  post<{ ok: boolean; moved: number; unchanged: number; operationId: string }>("/api/units/bulk-location", { unitCodes, location, movedAt, note });
export const bulkHide = (unitCodes: string[], hidden: boolean) => post<{ ok: boolean; units: number }>("/api/units/bulk-hide", { unitCodes, hidden });
export interface BulkEventInput {
  unitCodes: string[]; functionCode: string; title: string; eventTime?: string; note?: string; statusChange?: string;
  temperatureC?: number; humidityRh?: number; sourceUnitCode?: string; method?: string; amount?: string;
}
export const recordEvents = (input: BulkEventInput) => post<{ ok: boolean; operationId: string; eventIds: string[] }>("/api/events/bulk", input);
export interface BulkCreateInput {
  base: string; count: number; type?: string; substrate?: string; strainCode?: string; status?: string; batchTime?: string;
  location?: string; origins?: OriginInput[]; notes?: string; description?: string;
}
export const bulkCreateUnits = (input: BulkCreateInput) => post<{ ok: boolean; operationId: string; codes: string[] }>("/api/units/bulk", input);
export const createTransfer = (input: { sourceUnitCode: string; targetUnitCode: string; transferTime?: string; method: string; amount: string; note?: string;
  targetUnit?: { code?: string; type: string; substrate?: string; strainCode?: string; notes?: string } }) => post<{ ok: boolean; operationId: string }>("/api/transfers", input);
export const exportUrl = (code: string, format: "json" | "csv") => `/api/units/${encodeURIComponent(code)}/export?format=${format}`;
