export const ESTIMATE_LABEL: string;
export const FILL_GRAPHIC: { x: number; y: number; pumpX: number };
export const FILL_DISCHARGE_PATH: string;
export const FILL_SCENE: { w: number; h: number };

export type FillPresentation = {
  outputKind: string;
  outputLabel: string;
  outputDetail: string;
  outputNote: string;
  enableKind: string;
  enableLabel: string;
  enableWritable: boolean;
  fault: boolean;
  bellTitle: string;
  pipeAnimate: boolean;
  tankMode: string;
  coarsePct: number | null;
  qualityLabel: string;
  label: string;
  zeroNote: string | null;
  meaning: string;
  noAnchorNote: string | null;
};

export type FillActionEffect = {
  type: "open-modal" | "confirm-enable" | "open-source" | "confirm-refill" | "confirm-reference" | "none";
  ack: boolean;
  plcWrite: false | "Cfg_Enable";
  next?: boolean;
  confirmText?: string;
};

export type SourceRefLog = {
  at?: string;
  atMs?: number;
  oldS: number;
  newS: number;
  by?: string;
  atLabel: string;
};

export type SourceDialogModel = {
  title: string;
  label: string;
  meaning: string;
  fullRefill: string;
  fullRefillHelp: string;
  refHelp: string;
  noAnchor: string;
  zeroNote: string;
  referenceS: number;
  accumulatedS: number | null;
  coarsePct: number | null;
  available: boolean;
  qualityNote: string;
  refLog: SourceRefLog[];
};

export function formatHelsinki(iso: string | number | null | undefined): string;
export function buildFillPresentation(fill: unknown, estimate: unknown, estimateError?: string | null): FillPresentation;
export function fillActionEffect(action: string, pres?: { busy?: boolean; enableWritable?: boolean; enableKind?: string } | null): FillActionEffect;
export function sourceDialogModel(estimate?: {
  referenceS?: number;
  accumulatedS?: number | null;
  available?: boolean;
  remainingCoarsePct?: number | null;
  qualityNote?: string;
  refLog?: { at?: string; atMs?: number; oldS: number; newS: number; by?: string }[];
} | null): SourceDialogModel;
export function renderFillPumpInner(pres: FillPresentation, opts?: { interactive?: boolean; clipId?: string }): string;
export function renderExampleHtml(): string;
