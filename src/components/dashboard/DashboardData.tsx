import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getDbState,
  getLatestEnvironmentReadings,
  getTrendVariables,
  type TrendVariable,
} from "@/lib/apiClient";
import type { EnvironmentReading, MEvent, Unit } from "@/types";

interface DashboardData {
  units: Unit[];
  events: MEvent[];
  readings: EnvironmentReading[];
  variables: TrendVariable[];
  status: "loading" | "ok" | "error";
  error: string;
  /** Increments on every refresh so widgets that fetch their own data can reload. */
  tick: number;
  refresh: () => void;
}

const Ctx = createContext<DashboardData | null>(null);

// One shared fetch of the big state + latest readings for all widgets (refresh every 60 s),
// instead of each widget pulling /api/state itself.
export function DashboardDataProvider({ children }: { children: ReactNode }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [events, setEvents] = useState<MEvent[]>([]);
  const [readings, setReadings] = useState<EnvironmentReading[]>([]);
  const [variables, setVariables] = useState<TrendVariable[]>([]);
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const [state, latest] = await Promise.all([getDbState(), getLatestEnvironmentReadings()]);
      if (!alive.current) return;
      setUnits(state.units);
      setEvents(state.events);
      setReadings(latest);
      setStatus("ok");
      setError("");
    } catch (e) {
      if (!alive.current) return;
      setStatus("error");
      setError((e as Error).message);
    }
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    getTrendVariables()
      .then((v) => alive.current && setVariables(v))
      .catch(() => undefined);
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <Ctx.Provider value={{ units, events, readings, variables, status, error, tick, refresh: () => void load() }}>
      {children}
    </Ctx.Provider>
  );
}

export function useDashboardData() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDashboardData must be used inside DashboardDataProvider");
  return v;
}
