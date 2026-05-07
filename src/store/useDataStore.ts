import { useSyncExternalStore } from "react";
import {
  events as initialEvents,
  strains as initialStrains,
  transfers as initialTransfers,
  units as initialUnits,
} from "@/data/mockData";
import type { MEvent, Strain, Transfer, Unit, UnitStatus } from "@/types";

export interface Taxonomy {
  functions: string[];
  types: string[];
  statuses: string[];
  qcTags: string[];
}

interface State {
  strains: Strain[];
  units: Unit[];
  events: MEvent[];
  transfers: Transfer[];
  taxonomy: Taxonomy;
}

export interface PersistedMykoState extends State {
  schemaVersion: number;
  savedAt: string;
}

const STORAGE_KEY = "myko-valvomo-state-v1";
const SCHEMA_VERSION = 1;

const defaultTaxonomy: Taxonomy = {
  functions: ["COL", "FRU", "OBS", "QC", "TRF", "HAR", "PREP"],
  types: ["BOX", "JAR", "PD", "LC", "BAG", "OTHER"],
  statuses: ["ACTIVE", "CONTAMINATED", "DISCARDED", "HARVESTED", "ARCHIVED"],
  qcTags: [
    "CONTAMINATION_SUSPECTED",
    "CONTAMINATION_CONFIRMED",
    "BAD_SMELL",
    "EXCESSIVE_MOISTURE",
    "DRYING",
    "DISCARDED",
  ],
};

const initialState = (): State => ({
  strains: [...initialStrains],
  units: [...initialUnits],
  events: [...initialEvents],
  transfers: [...initialTransfers],
  taxonomy: cloneTaxonomy(defaultTaxonomy),
});

let state: State = loadState();

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());
const getSnapshot = () => state;

function setState(next: Partial<State>, options: { persist?: boolean } = {}) {
  state = normalizeState({ ...state, ...next });
  if (options.persist !== false) persistState(state);
  emit();
}

let counter = getInitialCounter(state);
const newId = (prefix: string) => `${prefix}-${++counter}`;

export function useDataStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const dataActions = {
  addEvent(event: Omit<MEvent, "id">): MEvent {
    const e: MEvent = { ...event, id: newId("evt") };
    const units = event.statusChange
      ? state.units.map((u) => (u.code === event.unitCode ? { ...u, status: event.statusChange as UnitStatus } : u))
      : state.units;
    setState({ events: [...state.events, e], units });
    return e;
  },
  updateEvent(id: string, patch: Partial<Omit<MEvent, "id">>) {
    setState({ events: state.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  },
  deleteEvent(id: string) {
    setState({ events: state.events.filter((e) => e.id !== id) });
  },
  addTransfer(input: Omit<Transfer, "id"> & { targetUnit?: Partial<Unit> }): Transfer {
    const t: Transfer = {
      id: newId("trf"),
      sourceUnitCode: input.sourceUnitCode,
      targetUnitCode: input.targetUnitCode,
      transferTime: input.transferTime,
      method: input.method,
      amount: input.amount,
      description: input.description,
      note: input.note,
    };
    let units = state.units;
    const exists = units.find((u) => u.code === input.targetUnitCode);
    if (!exists && input.targetUnit) {
      const source = units.find((u) => u.code === input.sourceUnitCode);
      const newUnit: Unit = {
        code: input.targetUnitCode,
        type: (input.targetUnit.type ?? "BOX") as Unit["type"],
        strainCode: input.targetUnit.strainCode ?? source?.strainCode ?? "OST",
        status: "ACTIVE",
        batchTime: input.transferTime,
        parentUnitCode: input.sourceUnitCode,
        substrate: input.targetUnit.substrate,
        description: input.targetUnit.description,
        notes: input.targetUnit.notes,
      };
      units = [...units, newUnit];
    }
    setState({ transfers: [...state.transfers, t], units });
    // Also log a TRF event on the source
    dataActions.addEvent({
      functionCode: "TRF",
      unitCode: input.sourceUnitCode,
      eventTime: input.transferTime,
      title: `Transfer to ${input.targetUnitCode}`,
      note: `${input.method} — ${input.amount}${input.note ? ` — ${input.note}` : ""}`,
    });
    return t;
  },
  updateTransfer(id: string, patch: Partial<Omit<Transfer, "id">>) {
    setState({ transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  },
  deleteTransfer(id: string) {
    setState({ transfers: state.transfers.filter((t) => t.id !== id) });
  },
  updateUnit(code: string, patch: Partial<Omit<Unit, "code">>) {
    setState({ units: state.units.map((u) => (u.code === code ? { ...u, ...patch } : u)) });
  },
  deleteUnit(code: string) {
    setState({ units: state.units.filter((u) => u.code !== code) });
  },
  addStrain(strain: Strain) {
    if (state.strains.some((s) => s.code === strain.code)) return;
    setState({ strains: [...state.strains, strain] });
  },
  updateStrain(code: string, patch: Partial<Omit<Strain, "code">>) {
    setState({ strains: state.strains.map((s) => (s.code === code ? { ...s, ...patch } : s)) });
  },
  deleteStrain(code: string) {
    setState({ strains: state.strains.filter((s) => s.code !== code) });
  },
  updateUnitStatus(unitCode: string, status: UnitStatus) {
    setState({
      units: state.units.map((u) => (u.code === unitCode ? { ...u, status } : u)),
    });
  },
  addTag(category: keyof Taxonomy, value: string) {
    const v = value.trim().toUpperCase();
    if (!v) return;
    if (state.taxonomy[category].includes(v)) return;
    setState({ taxonomy: { ...state.taxonomy, [category]: [...state.taxonomy[category], v] } });
  },
  renameTag(category: keyof Taxonomy, oldValue: string, newValue: string) {
    const v = newValue.trim().toUpperCase();
    if (!v || v === oldValue) return;
    const list = state.taxonomy[category].map((x) => (x === oldValue ? v : x));
    let units = state.units;
    let events = state.events;
    if (category === "types") {
      units = units.map((u) => (u.type === oldValue ? { ...u, type: v as Unit["type"] } : u));
    } else if (category === "statuses") {
      units = units.map((u) => (u.status === oldValue ? { ...u, status: v as UnitStatus } : u));
      events = events.map((e) => (e.statusChange === oldValue ? { ...e, statusChange: v as UnitStatus } : e));
    } else if (category === "functions") {
      events = events.map((e) => (e.functionCode === oldValue ? { ...e, functionCode: v as MEvent["functionCode"] } : e));
    } else if (category === "qcTags") {
      events = events.map((e) =>
        e.qcTags ? { ...e, qcTags: e.qcTags.map((t) => (t === oldValue ? (v as any) : t)) as MEvent["qcTags"] } : e,
      );
    }
    setState({ taxonomy: { ...state.taxonomy, [category]: list }, units, events });
  },
  removeTag(category: keyof Taxonomy, value: string) {
    const inUse =
      (category === "types" && state.units.some((u) => u.type === value)) ||
      (category === "statuses" && (state.units.some((u) => u.status === value) || state.events.some((e) => e.statusChange === value))) ||
      (category === "functions" && state.events.some((e) => e.functionCode === value)) ||
      (category === "qcTags" && state.events.some((e) => e.qcTags?.includes(value as any)));
    if (inUse) throw new Error(`Tag "${value}" is in use and cannot be removed.`);
    setState({ taxonomy: { ...state.taxonomy, [category]: state.taxonomy[category].filter((x) => x !== value) } });
  },
  exportState(): PersistedMykoState {
    return toPersistedState(state);
  },
  importState(input: unknown) {
    const imported = normalizeState(input as Partial<State>);
    state = imported;
    counter = getInitialCounter(state);
    persistState(state);
    emit();
  },
  resetToMockData() {
    state = initialState();
    counter = getInitialCounter(state);
    persistState(state);
    emit();
  },
  clearLocalStorage() {
    safeLocalStorage()?.removeItem(STORAGE_KEY);
  },
};

function loadState(): State {
  const storage = safeLocalStorage();
  if (!storage) return initialState();

  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return initialState();

  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn("Failed to load Myko Valvomo state from localStorage", error);
    return initialState();
  }
}

function persistState(value: State) {
  const storage = safeLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(toPersistedState(value)));
  } catch (error) {
    console.warn("Failed to persist Myko Valvomo state to localStorage", error);
  }
}

function toPersistedState(value: State): PersistedMykoState {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    strains: value.strains,
    units: value.units,
    events: value.events,
    transfers: value.transfers,
    taxonomy: value.taxonomy,
  };
}

function normalizeState(input: Partial<State> | Partial<PersistedMykoState> | null | undefined): State {
  const fallback = initialState();
  const imported = input ?? {};

  const strains = Array.isArray(imported.strains) ? imported.strains : fallback.strains;
  const units = Array.isArray(imported.units) ? imported.units : fallback.units;
  const events = Array.isArray(imported.events) ? imported.events : fallback.events;
  const transfers = Array.isArray(imported.transfers) ? imported.transfers : fallback.transfers;

  return {
    strains,
    units,
    events,
    transfers,
    taxonomy: normalizeTaxonomy(imported.taxonomy),
  };
}

function normalizeTaxonomy(input?: Partial<Taxonomy>): Taxonomy {
  const merged: Taxonomy = cloneTaxonomy(defaultTaxonomy);
  if (!input) return merged;

  for (const key of Object.keys(merged) as (keyof Taxonomy)[]) {
    const values = input[key];
    if (Array.isArray(values)) {
      merged[key] = uniqueUpper([...merged[key], ...values]);
    }
  }
  return merged;
}

function cloneTaxonomy(value: Taxonomy): Taxonomy {
  return {
    functions: [...value.functions],
    types: [...value.types],
    statuses: [...value.statuses],
    qcTags: [...value.qcTags],
  };
}

function uniqueUpper(values: string[]) {
  return Array.from(new Set(values.map((v) => String(v).trim().toUpperCase()).filter(Boolean)));
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getInitialCounter(value: State) {
  const ids = [...value.events.map((e) => e.id), ...value.transfers.map((t) => t.id)];
  const max = ids.reduce((acc, id) => {
    const match = String(id).match(/-(\d+)$/);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 1000);
  return max;
}
