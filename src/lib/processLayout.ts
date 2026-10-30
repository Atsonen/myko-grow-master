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

/** Default layout matching the hard-coded SVG positions (before user edits). */
export const DEFAULT_PROCESS_BOXES: ProcessBoxMap = {
  "vb-fan": { x: 694, y: 108, w: 92, h: 40 },
  "vb-duct": { x: 560, y: 92, w: 92, h: 40 },
  "pid-gair": { x: 560, y: 160, w: 226, h: 44 },
  "vb-roof": { x: 400, y: 60, w: 92, h: 40 },
  "vb-mid": { x: 400, y: 110, w: 92, h: 40 },
  "btn-s-mid": { x: 500, y: 117, w: 28, h: 26 },
  "btn-asetukset": { x: 20, y: 16, w: 90, h: 26 },
  "btn-ec": { x: 118, y: 16, w: 50, h: 26 },
  "btn-ph": { x: 176, y: 16, w: 50, h: 26 },
  "btn-s-top": { x: 20, y: 50, w: 28, h: 26 },
  "btn-halytykset": { x: 840, y: 110, w: 90, h: 26 },
  "btn-kuittaus": { x: 840, y: 146, w: 90, h: 26 },
  "vb-pinta": { x: 442, y: 330, w: 100, h: 40 },
  "vb-vesi": { x: 442, y: 376, w: 100, h: 40 },
  "vb-ec": { x: 442, y: 422, w: 100, h: 40 },
  "vb-ph": { x: 442, y: 468, w: 100, h: 40 },
  "vb-g1": { x: 560, y: 280, w: 100, h: 40 },
  "btn-s-g1": { x: 666, y: 287, w: 28, h: 26 },
  "vb-ajastin": { x: 560, y: 226, w: 100, h: 40 },
  "vb-kosteus": { x: 120, y: 84, w: 100, h: 40 },
  "vb-lammitin-t": { x: 200, y: 505, w: 92, h: 40 },
};

const MIN_W = 28;
const MIN_H = 20;
const VIEW_W = 960;
const VIEW_H = 580;

export function clampBox(b: ProcessBox): ProcessBox {
  const w = Math.max(MIN_W, Math.min(VIEW_W, Math.round(b.w)));
  const h = Math.max(MIN_H, Math.min(VIEW_H, Math.round(b.h)));
  const x = Math.max(0, Math.min(VIEW_W - w, Math.round(b.x)));
  const y = Math.max(0, Math.min(VIEW_H - h, Math.round(b.y)));
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
};

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

export function boxesToSaved(boxes: ProcessBoxMap): SavedLayout {
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
  };
}

export async function loadProcessBoxes(): Promise<ProcessBoxMap> {
  const r = await getDashboardLayout<SavedLayout>(PROCESS_LAYOUT_ID);
  return boxesFromSaved(r.layout);
}

export async function saveProcessBoxes(boxes: ProcessBoxMap): Promise<ProcessBoxMap> {
  const payload = boxesToSaved(boxes);
  const r = await saveDashboardLayout(payload, PROCESS_LAYOUT_ID);
  return boxesFromSaved(r.layout as SavedLayout);
}

export async function resetProcessBoxes(): Promise<ProcessBoxMap> {
  await resetDashboardLayout(PROCESS_LAYOUT_ID);
  return mergeProcessBoxes(null);
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
