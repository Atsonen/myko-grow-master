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
  | "note";

export interface WidgetConfigMap {
  sensorLatest: { variableId?: string };
  /** bucket unset = auto by range (24 h → 10 min). series/axes = widget overrides. */
  trend: { variableIds?: string[]; rangeHours?: number; bucket?: TrendBucket | "auto" } & TrendStyling;
  unitsByStatus: { mode?: "count" | "list"; status?: UnitStatus };
  recentEvents: { limit?: number; functionCode?: string };
  locationSummary: Record<string, never>;
  unitCurve: { unitCode?: string };
  note: { text?: string };
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
  version: 1;
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
  note: { label: "Note", description: "Free text note.", w: 3, h: 3, minW: 2, minH: 2 },
};

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
