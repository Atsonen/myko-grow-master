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

const defaultSources: EnvironmentSource[] = [
  {
    id: "src-sensorblock-1",
    name: "SensorBlock 1",
    location: "SENSORBLOCK-1",
    mqttTopic: "Sensors/SensorBlock_1",
    channelMap: [
      {
        payloadKey: "DStemp1",
        alias: "T1",
        location: "TERRARIO-1",
        metric: "temperatureC",
        description: "Terrario 1 temperature sensor.",
      },
      {
        payloadKey: "DStemp2",
        alias: "F1",
        location: "KYLMASAILYTYSTILA-1",
        metric: "temperatureC",
        description: "Kylmäsäilytystila 1 temperature sensor.",
      },
    ],
    description: "Internal MQTT JSON payload from Sensors/SensorBlock_1. DStemp1=T1/Terrario 1, DStemp2=F1/Kylmäsäilytystila 1.",
  },
];

const initialState = (): EnvironmentState => ({
  locationRecords: [],
  readings: [],
  sources: defaultSources,
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
  addReadingsFromSensorBlock1(payload: Record<string, unknown>, timestamp = new Date().toISOString()) {
    const source = state.sources.find((s) => s.id === "src-sensorblock-1");
    if (!source?.channelMap) return [];

    const readings = source.channelMap
      .map((channel) => {
        const raw = payload[channel.payloadKey];
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value)) return null;
        const reading: EnvironmentReading = {
          id: newId("env"),
          timestamp,
          location: channel.location,
          source: `${source.name}/${channel.alias}/${channel.payloadKey}`,
          note: source.mqttTopic,
        };
        if (channel.metric === "temperatureC") reading.temperatureC = value;
        if (channel.metric === "humidityRh") reading.humidityRh = value;
        if (channel.metric === "co2Ppm") reading.co2Ppm = value;
        return reading;
      })
      .filter(Boolean) as EnvironmentReading[];

    if (readings.length) setState({ readings: [...state.readings, ...readings] });
    return readings;
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
  const inputSources = Array.isArray(input?.sources) ? input.sources : [];
  const mergedSources = mergeDefaultSources(inputSources);

  return {
    locationRecords: Array.isArray(input?.locationRecords) ? input.locationRecords : fallback.locationRecords,
    readings: Array.isArray(input?.readings) ? input.readings : fallback.readings,
    sources: mergedSources,
  };
}

function mergeDefaultSources(inputSources: EnvironmentSource[]) {
  const byId = new Map<string, EnvironmentSource>();
  for (const source of defaultSources) byId.set(source.id, source);
  for (const source of inputSources) {
    const defaultSource = byId.get(source.id);
    byId.set(source.id, defaultSource ? { ...defaultSource, ...source, channelMap: source.channelMap ?? defaultSource.channelMap } : source);
  }
  return Array.from(byId.values());
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
