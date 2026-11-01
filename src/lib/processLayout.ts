/**
 * Kasvamo Prosessikuva – element positions/sizes (SVG viewBox px).
 * Persisted via dashboard_layouts id=plants_process (same API as panel layout).
 */
import {
  getDashboardLayout,
  resetDashboardLayout,
  saveDashboardLayout,
} from "@/lib/apiClient";

export const PROCESS_LAYOUT_ID = "plants_process";

export type ProcessBox = { x: number; y: number; w: number; h: number };
export type ProcessBoxMap = Record<string, ProcessBox>;

/** Diagram zoom inside the widget. scale=null = fit-to-widget (default). 1 = 100%. */
export type ProcessZoom = {
  scale: number | null;
  panX: number;
  panY: number;
};

export const DEFAULT_PROCESS_ZOOM: ProcessZoom = { scale: null, panX: 0, panY: 0 };

/** Default layout matching the hard-coded SVG positions (before user edits). */
export const DEFAULT_PROCESS_BOXES: ProcessBoxMap = {
  // Positions/sizes on PROCESS_GRID (10 px). Value tiles default 10×4 units (100×40).
  "vb-fan": { x: 690, y: 110, w: 100, h: 40 },
  "vb-duct": { x: 560, y: 90, w: 100, h: 40 },
  "vb-roof": { x: 400, y: 60, w: 100, h: 40 },
  "vb-mid": { x: 400, y: 110, w: 100, h: 40 },
  "btn-halytykset": { x: 840, y: 110, w: 90, h: 30 },
  "vb-pinta": { x: 440, y: 330, w: 100, h: 40 },
  "vb-vesi": { x: 440, y: 380, w: 100, h: 40 },
  "vb-ec": { x: 440, y: 430, w: 100, h: 40 },
  "vb-ph": { x: 440, y: 480, w: 100, h: 40 },
  "vb-g1": { x: 560, y: 280, w: 100, h: 40 },
  "vb-ajastin": { x: 560, y: 230, w: 100, h: 40 },
  "vb-kosteus": { x: 120, y: 80, w: 100, h: 40 },
  "vb-lammitin-t": { x: 200, y: 510, w: 100, h: 40 },
};

/** Snap grid in SVG viewBox px (≈ dashboard “units”: tile often 10×4 = 100×40). */
export const PROCESS_GRID = 10;
/** Default value-tile size in grid units (w×h): 10×4 → 100×40. */
export const PROCESS_TILE_UNITS = { w: 10, h: 4 } as const;
const MIN_W = PROCESS_GRID * 3; // 30
const MIN_H = PROCESS_GRID * 2; // 20
export const PROCESS_VIEW_W = 960;
export const PROCESS_VIEW_H = 580;
const VIEW_W = PROCESS_VIEW_W;
const VIEW_H = PROCESS_VIEW_H;

const snap = (n: number, g = PROCESS_GRID) => Math.round(n / g) * g;

/** Clamp to view + snap x/y/w/h to PROCESS_GRID (keeps saved layouts, snaps to nearest). */
export function clampBox(b: ProcessBox): ProcessBox {
  let w = Math.max(MIN_W, Math.min(VIEW_W, snap(b.w)));
  let h = Math.max(MIN_H, Math.min(VIEW_H, snap(b.h)));
  let x = snap(b.x);
  let y = snap(b.y);
  x = Math.max(0, Math.min(VIEW_W - w, x));
  y = Math.max(0, Math.min(VIEW_H - h, y));
  // Re-snap after clamp so edges stay on grid
  x = snap(x); y = snap(y);
  if (x + w > VIEW_W) x = Math.max(0, VIEW_W - w);
  if (y + h > VIEW_H) y = Math.max(0, VIEW_H - h);
  return { x, y, w, h };
}

export function mergeProcessBoxes(saved: ProcessBoxMap | null | undefined): ProcessBoxMap {
  const out: ProcessBoxMap = {};
  for (const [id, def] of Object.entries(DEFAULT_PROCESS_BOXES)) {
    const s = saved?.[id];
    out[id] = clampBox(s ? { ...def, ...s } : def);
  }
  return out;
}

type SavedLayout = {
  version?: number;
  widgets?: { id: string; type?: string; x?: number; y?: number; w?: number; h?: number }[];
  /** Optional zoom/pan persisted with element boxes (plants_process). */
  zoom?: { scale?: number | null; panX?: number; panY?: number };
};


export function clampProcessZoom(z: Partial<ProcessZoom> | null | undefined): ProcessZoom {
  const panX = Number.isFinite(Number(z?.panX)) ? Number(z?.panX) : 0;
  const panY = Number.isFinite(Number(z?.panY)) ? Number(z?.panY) : 0;
  const raw = z?.scale;
  if (raw === null || raw === undefined || raw === ("" as unknown)) {
    return { scale: null, panX, panY };
  }
  const s = Number(raw);
  if (!Number.isFinite(s) || s <= 0) return { scale: null, panX, panY };
  // Keep a sane range so runaway values cannot blow the layout.
  return { scale: Math.min(4, Math.max(0.15, Math.round(s * 1000) / 1000)), panX, panY };
}

export function zoomFromSaved(layout: SavedLayout | null): ProcessZoom {
  return clampProcessZoom(layout?.zoom);
}

export function boxesFromSaved(layout: SavedLayout | null): ProcessBoxMap {
  const m: ProcessBoxMap = {};
  for (const w of layout?.widgets ?? []) {
    if (!w?.id) continue;
    if (!(w.id in DEFAULT_PROCESS_BOXES)) continue;
    m[w.id] = clampBox({
      x: Number(w.x) || 0,
      y: Number(w.y) || 0,
      w: Number(w.w) || DEFAULT_PROCESS_BOXES[w.id].w,
      h: Number(w.h) || DEFAULT_PROCESS_BOXES[w.id].h,
    });
  }
  return mergeProcessBoxes(m);
}

export function boxesToSaved(boxes: ProcessBoxMap, zoom: ProcessZoom = DEFAULT_PROCESS_ZOOM): SavedLayout {
  const z = clampProcessZoom(zoom);
  return {
    version: 2,
    widgets: Object.entries(boxes).map(([id, b]) => ({
      id,
      type: id.startsWith("btn-") ? "btn" : id.startsWith("pid-") ? "pid" : "valueBox",
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
    })),
    zoom: { scale: z.scale, panX: z.panX, panY: z.panY },
  };
}

export type ProcessLayoutState = { boxes: ProcessBoxMap; zoom: ProcessZoom };

export async function loadProcessLayout(): Promise<ProcessLayoutState> {
  const r = await getDashboardLayout<SavedLayout>(PROCESS_LAYOUT_ID);
  return { boxes: boxesFromSaved(r.layout), zoom: zoomFromSaved(r.layout) };
}

/** @deprecated Prefer loadProcessLayout (includes zoom). */
export async function loadProcessBoxes(): Promise<ProcessBoxMap> {
  return (await loadProcessLayout()).boxes;
}

export async function saveProcessLayout(boxes: ProcessBoxMap, zoom: ProcessZoom = DEFAULT_PROCESS_ZOOM): Promise<ProcessLayoutState> {
  const payload = boxesToSaved(boxes, zoom);
  const r = await saveDashboardLayout(payload, PROCESS_LAYOUT_ID);
  const layout = r.layout as SavedLayout;
  return { boxes: boxesFromSaved(layout), zoom: zoomFromSaved(layout) };
}

/** @deprecated Prefer saveProcessLayout. */
export async function saveProcessBoxes(boxes: ProcessBoxMap): Promise<ProcessBoxMap> {
  return (await saveProcessLayout(boxes, DEFAULT_PROCESS_ZOOM)).boxes;
}

export async function resetProcessLayout(): Promise<ProcessLayoutState> {
  await resetDashboardLayout(PROCESS_LAYOUT_ID);
  return { boxes: mergeProcessBoxes(null), zoom: { ...DEFAULT_PROCESS_ZOOM } };
}

/** @deprecated Prefer resetProcessLayout. */
export async function resetProcessBoxes(): Promise<ProcessBoxMap> {
  return (await resetProcessLayout()).boxes;
}

/** Map pointer client coords → SVG viewBox coords. */
export function clientToSvg(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}
