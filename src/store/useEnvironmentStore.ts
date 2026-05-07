import { useSyncExternalStore } from "react";
import type { EnvironmentReading, EnvironmentSource, UnitLocationRecord } from "@/types";

interface EnvironmentState {
  locationRecords: UnitLocationRecord[];
  readings: EnvironmentReading[];
  sources: EnvironmentSource[];
}

export interface PersistedEnvironmentState extends EnvironmentState {
  schemaVersion: number;
  savedAt: string;
}

const STORAGE_KEY = "myko-valvomo-environment-state-v1";
const SCHEMA_VERSION = 1;

const initialState = (): EnvironmentState => ({
  locationRecords: [],
  readings: [],
  sources: [
    {
      id: "src-default-temp",
      name: "Default grow room sensor",
      location: "GROW-ROOM",
      mqttTopic: "myko/growroom/temperature",
      description: "Placeholder for the internal MQTT temperature sensor.",
    },
  ],
});

let state: EnvironmentState = loadState();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = () => listeners.forEach((listener) => listener());
const getSnapshot = () => state;

let counter = getInitialCounter(state);
const newId = (prefix: string) => `${prefix}-${++counter}`;

export function useEnvironmentStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const environmentActions = {
  addLocationRecord(input: Omit<UnitLocationRecord, "id">): UnitLocationRecord {
    const record: UnitLocationRecord = { ...input, id: newId("loc") };
    setState({ locationRecords: [...state.locationRecords, record] });
    return record;
  },
  archiveLocationRecord(id: string) {
    setState({ locationRecords: state.locationRecords.map((r) => (r.id === id ? { ...r, archived: true } : r)) });
  },
  restoreLocationRecord(id: string) {
    setState({ locationRecords: state.locationRecords.map((r) => (r.id === id ? { ...r, archived: false } : r)) });
  },
  addReading(input: Omit<EnvironmentReading, "id">): EnvironmentReading {
    const reading: EnvironmentReading = { ...input, id: newId("env") };
    setState({ readings: [...state.readings, reading] });
    return reading;
  },
  archiveReading(id: string) {
    setState({ readings: state.readings.map((r) => (r.id === id ? { ...r, archived: true } : r)) });
  },
  restoreReading(id: string) {
    setState({ readings: state.readings.map((r) => (r.id === id ? { ...r, archived: false } : r)) });
  },
  addSource(input: Omit<EnvironmentSource, "id">): EnvironmentSource {
    const source: EnvironmentSource = { ...input, id: newId("src") };
    setState({ sources: [...state.sources, source] });
    return source;
  },
  updateSource(id: string, patch: Partial<Omit<EnvironmentSource, "id">>) {
    setState({ sources: state.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  },
  archiveSource(id: string) {
    setState({ sources: state.sources.map((s) => (s.id === id ? { ...s, archived: true } : s)) });
  },
  exportState(): PersistedEnvironmentState {
    return toPersistedState(state);
  },
  importState(input: unknown) {
    state = normalizeState(input as Partial<EnvironmentState>);
    counter = getInitialCounter(state);
    persistState(state);
    emit();
  },
  reset() {
    state = initialState();
    counter = getInitialCounter(state);
    persistState(state);
    emit();
  },
};

function setState(next: Partial<EnvironmentState>) {
  state = normalizeState({ ...state, ...next });
  persistState(state);
  emit();
}

function loadState(): EnvironmentState {
  const storage = safeLocalStorage();
  if (!storage) return initialState();
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return initialState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn("Failed to load environment state", error);
    return initialState();
  }
}

function persistState(value: EnvironmentState) {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(toPersistedState(value)));
  } catch (error) {
    console.warn("Failed to persist environment state", error);
  }
}

function toPersistedState(value: EnvironmentState): PersistedEnvironmentState {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    locationRecords: value.locationRecords,
    readings: value.readings,
    sources: value.sources,
  };
}

function normalizeState(input: Partial<EnvironmentState> | Partial<PersistedEnvironmentState> | null | undefined): EnvironmentState {
  const fallback = initialState();
  return {
    locationRecords: Array.isArray(input?.locationRecords) ? input.locationRecords : fallback.locationRecords,
    readings: Array.isArray(input?.readings) ? input.readings : fallback.readings,
    sources: Array.isArray(input?.sources) ? input.sources : fallback.sources,
  };
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getInitialCounter(value: EnvironmentState) {
  const ids = [...value.locationRecords.map((r) => r.id), ...value.readings.map((r) => r.id), ...value.sources.map((s) => s.id)];
  return ids.reduce((acc, id) => {
    const match = String(id).match(/-(\d+)$/);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 2000);
}
