import { useSyncExternalStore } from "react";
import {
  events as initialEvents,
  strains as initialStrains,
  transfers as initialTransfers,
  units as initialUnits,
} from "@/data/mockData";
import type { MEvent, Strain, Transfer, Unit, UnitStatus } from "@/types";

interface State {
  strains: Strain[];
  units: Unit[];
  events: MEvent[];
  transfers: Transfer[];
}

let state: State = {
  strains: [...initialStrains],
  units: [...initialUnits],
  events: [...initialEvents],
  transfers: [...initialTransfers],
};

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());
const getSnapshot = () => state;

function setState(next: Partial<State>) {
  state = { ...state, ...next };
  emit();
}

let counter = 1000;
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
};