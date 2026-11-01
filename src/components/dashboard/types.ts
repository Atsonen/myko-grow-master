import type { UnitStatus } from "@/types";
import type { TrendBucket } from "@/lib/apiClient";
import type { TrendStyling } from "@/lib/seriesStyle";

export type WidgetType =
  | "sensorLatest"
  | "trend"
  | "unitsByStatus"
  | "recentEvents"
  | "locationSummary"
  | "unitCurve"
  | "note"
  | "statusBits"
  | "measurementPoint"
  | "alarmList"
  | "weather"
  | "outdoorTemp"
  | "spaceWeather"
  | "sensorBlock"
  | "processDiagram"
  | "circSequence"
  | "fertDose";

export interface WidgetConfigMap {
  sensorLatest: { variableId?: string };
  /** bucket unset = auto by range (24 h → 10 min). series/axes = widget overrides. */
  trend: { variableIds?: string[]; rangeHours?: number; bucket?: TrendBucket | "auto"; showPumpRuns?: boolean } & TrendStyling;
  unitsByStatus: { mode?: "count" | "list"; status?: UnitStatus };
  recentEvents: { limit?: number; functionCode?: string };
  locationSummary: Record<string, never>;
  unitCurve: { unitCode?: string };
  note: { text?: string };
  /** bits: subset of defined bit numbers to show (empty = all). */
  statusBits: { variableKey?: string; bits?: number[]; staleMinutes?: number };
  /** pointId = alarm_points.id; name overrides the point name. */
  measurementPoint: { pointId?: string; name?: string };
  weather: Record<string, never>;
  outdoorTemp: Record<string, never>;
  spaceWeather: Record<string, never>;
  alarmList: { hours?: number; limit?: number; pointId?: string; priority?: 1 | 2; activeOnly?: boolean; storageKey?: string };
  /** device: MQTT device name; empty = first configured. */
  sensorBlock: { device?: string };
  processDiagram: Record<string, never>;
  circSequence: Record<string, never>;
  fertDose: Record<string, never>;
}

export interface DashboardWidget<T extends WidgetType = WidgetType> {
  id: string;
  type: T;
  title?: string;
  config: WidgetConfigMap[T];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  version: 1 | 2;
  widgets: DashboardWidget[];
}

export const WIDGET_META: Record<
  WidgetType,
  { label: string; description: string; w: number; h: number; minW: number; minH: number }
> = {
  sensorLatest: { label: "Sensor value", description: "Latest value of one sensor / datalogger variable.", w: 3, h: 3, minW: 2, minH: 2 },
  trend: { label: "Trend chart", description: "One or more variables over a time range.", w: 6, h: 6, minW: 3, minH: 4 },
  unitsByStatus: { label: "Units by status", description: "Counts per status, or a list of units with one status.", w: 3, h: 5, minW: 2, minH: 3 },
  recentEvents: { label: "Recent events", description: "Latest events (optionally one function code).", w: 4, h: 6, minW: 3, minH: 3 },
  locationSummary: { label: "Locations", description: "Units per location with current temperature.", w: 4, h: 5, minW: 3, minH: 3 },
  unitCurve: { label: "Unit lifetime curve", description: "Temperature across one unit's lifetime.", w: 6, h: 6, minW: 3, minH: 4 },
  statusBits: { label: "Status bits", description: "Lamps for the bits of a datalogger status word.", w: 4, h: 3, minW: 2, minH: 2 },
  measurementPoint: { label: "Mittauspiste", description: "Measurement point: value + alarm status, expandable bits and event history.", w: 1.5, h: 4, minW: 1, minH: 3 },
  alarmList: { label: "Hälytyslista", description: "Alarm summary across all measurement points: time, point, type, priority, state, value, duration.", w: 8, h: 6, minW: 4, minH: 4 },
  outdoorTemp: { label: "Sää", description: "Ulkolämpötila, kosteus, päivän/yön alin–ylin (FMI Röykkä / Rajamäki).", w: 2, h: 4, minW: 1, minH: 2 },
  weather: { label: "Sääennuste", description: "FMI: nykyinen sää (Nurmijärvi Röykkä) ja 48 h ennuste Rajamäelle.", w: 6, h: 6, minW: 3, minH: 4 },
  spaceWeather: { label: "Avaruussää", description: "Kp-indeksi + ennuste, aurinkotuuli, Nurmijärven magnetometri, revontulien todennäköisyys.", w: 6, h: 6, minW: 3, minH: 4 },
  note: { label: "Note", description: "Free text note.", w: 3, h: 3, minW: 2, minH: 2 },
  sensorBlock: { label: "SensorBlock", description: "SensorBlock-faceplate: telemetria, testit, puhallin (Schema ≥ 4).", w: 3, h: 4, minW: 2, minH: 3 },
  processDiagram: { label: "Prosessikuva", description: "Kasvamo-prosessikuva (SVG) elementtien muokkauksella.", w: 8.5, h: 11, minW: 4, minH: 6 },
  circSequence: { label: "Kiertovesisekvenssi", description: "FB_Sequence-tila ja Myko-asetukset (ei PLC-kirjoitusta asetuksista).", w: 8.5, h: 8, minW: 3, minH: 4 },
  fertDose: { label: "Lannoiteannostelu", description: "EC / lannoiteannostelun tila ja ohjaus.", w: 8.5, h: 3, minW: 3, minH: 3 },
};

export const TREND_RANGES = [
  { h: 0.5, label: "30 min" },
  { h: 1, label: "1 h" },
  { h: 3, label: "3 h" },
  { h: 6, label: "6 h" },
  { h: 24, label: "24 h" },
  { h: 72, label: "3 d" },
  { h: 168, label: "7 d" },
  { h: 720, label: "30 d" },
  { h: 2160, label: "90 d" },
] as const;

export function trendRangeLabel(hours: number): string {
  return TREND_RANGES.find((r) => r.h === hours)?.label ?? `${hours} h`;
}

export const STATUSES: UnitStatus[] = ["ACTIVE", "CONTAMINATED", "DISCARDED", "HARVESTED", "ARCHIVED"];

export function newWidgetId() {
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    { id: "d-status", type: "unitsByStatus", config: { mode: "count" }, x: 0, y: 0, w: 3, h: 5 },
    { id: "d-locations", type: "locationSummary", config: {}, x: 3, y: 0, w: 4, h: 5 },
    { id: "d-t1", type: "sensorLatest", title: "Terrario 1", config: { variableId: "env:temperatureC:TERRARIO-1" }, x: 7, y: 0, w: 2, h: 3 },
    { id: "d-f1", type: "sensorLatest", title: "Kylmäsäilytystila 1", config: { variableId: "env:temperatureC:KYLMASAILYTYSTILA-1" }, x: 9, y: 0, w: 3, h: 3 },
    { id: "d-note", type: "note", config: { text: "Edit mode: drag widgets by their header, resize from the corner, add widgets with “Add widget”." }, x: 7, y: 3, w: 5, h: 2 },
    {
      id: "d-trend",
      type: "trend",
      title: "Temperatures, 24 h",
      config: { variableIds: ["env:temperatureC:TERRARIO-1", "env:temperatureC:KYLMASAILYTYSTILA-1"], rangeHours: 24 },
      x: 0, y: 5, w: 8, h: 7,
    },
    { id: "d-events", type: "recentEvents", config: { limit: 8 }, x: 8, y: 5, w: 4, h: 7 },
    { id: "d-contam", type: "unitsByStatus", title: "Contaminated", config: { mode: "list", status: "CONTAMINATED" }, x: 0, y: 12, w: 4, h: 5 },
  ],
};

/** Default layout for Kasvamo process view (24-col, version 2). */
export const PLANTS_DEFAULT_LAYOUT: DashboardLayout = {
  version: 2,
  widgets: [
    { id: "process", type: "processDiagram", title: "Prosessikuva", config: {}, x: 0, y: 0, w: 17, h: 11 },
    { id: "alarms", type: "alarmList", title: "Hälytykset", config: { hours: 24, storageKey: "kasvamo" }, x: 17, y: 0, w: 7, h: 22 },
    { id: "sequence", type: "circSequence", title: "Kiertovesisekvenssi", config: {}, x: 0, y: 11, w: 17, h: 8 },
    { id: "fert", type: "fertDose", title: "Lannoiteannostelu", config: {}, x: 0, y: 19, w: 17, h: 3 },
    { id: "notes", type: "note", title: "Selite", config: { text: "Harmaat katkoviivalla merkityt elementit: ei kytketty \u2013 signaalia ei ole tunnistettu Myko-datasta varmasti (pH\u00b1, l\u00e4mmittimet, vesis\u00e4ili\u00f6n pinta, painikkeet). Kytketyt arvot: Datalogger; OPC UA Pumput_DB \u2013 pumput L/R, t\u00e4ytt\u00f6, ajastin, h\u00e4lytykset, kosteus, pinta/EC-asetusarvot; FB_FertDose_DB \u2013 Lannoite (Pump/Enable, K\u00e4ytt\u00f6 On/Off). Vain Enable kirjoitetaan." }, x: 0, y: 22, w: 24, h: 2 },
  ],
};

/** Map legacy PanelLayout rows (type:"panel") to dashboard widgets; preserve x/y/w/h. */
export function migrateLegacyPanelWidget(raw: Record<string, unknown>): DashboardWidget | null {
  try {
  const id = String(raw?.id ?? "");
  const x = Number(raw.x) || 0;
  const y = Number(raw.y) || 0;
  const w = Number(raw.w) || 4;
  const h = Number(raw.h) || 4;
  const type = String(raw.type ?? "");
  if (type in WIDGET_META) {
    return {
      id,
      type: type as WidgetType,
      title: typeof raw.title === "string" ? raw.title : undefined,
      config: (raw.config as DashboardWidget["config"]) ?? {},
      x, y, w, h,
    };
  }
  if (type !== "panel" && type !== "") return null;
  switch (id) {
    case "process":
      return { id, type: "processDiagram", title: "Prosessikuva", config: {}, x, y, w, h };
    case "alarms":
      return { id, type: "alarmList", title: "Hälytykset", config: { hours: 24, storageKey: "kasvamo" }, x, y, w, h };
    case "sequence":
      return { id, type: "circSequence", title: "Kiertovesisekvenssi", config: {}, x, y, w, h };
    case "fert":
      return { id, type: "fertDose", title: "Lannoiteannostelu", config: {}, x, y, w, h };
    case "notes":
      return { id, type: "note", title: "Selite", config: { text: "Harmaat katkoviivalla merkityt elementit: ei kytketty \u2013 signaalia ei ole tunnistettu Myko-datasta varmasti (pH\u00b1, l\u00e4mmittimet, vesis\u00e4ili\u00f6n pinta, painikkeet). Kytketyt arvot: Datalogger; OPC UA Pumput_DB \u2013 pumput L/R, t\u00e4ytt\u00f6, ajastin, h\u00e4lytykset, kosteus, pinta/EC-asetusarvot; FB_FertDose_DB \u2013 Lannoite (Pump/Enable, K\u00e4ytt\u00f6 On/Off). Vain Enable kirjoitetaan." }, x, y, w, h };
    default:
      return null;
  }
  } catch {
    return null;
  }
}
