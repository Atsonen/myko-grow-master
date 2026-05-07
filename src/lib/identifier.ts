import type { ContainerType, FunctionCode, MEvent, Unit, Strain } from "@/types";

export interface IdentifierParts {
  functionCode: FunctionCode;
  type: ContainerType;
  eventTime: string;
  strainCode: string;
  unitCode: string;
  strainDescription?: string;
  unitDescription?: string;
}

export function buildIdentifier(parts: Partial<IdentifierParts>): string {
  const f = parts.functionCode ?? "___";
  const t = parts.type ?? "___";
  const time = parts.eventTime ? formatEventTime(parts.eventTime) : "________";
  const s = parts.strainCode ?? "___";
  const u = parts.unitCode ?? "___";
  const sDesc = parts.strainDescription ? `(${parts.strainDescription})` : "";
  const uDesc = parts.unitDescription ? `(${parts.unitDescription})` : "";
  return `=${f}/+${t}/&${time}/#${s}${sDesc}/@${u}${uDesc}`;
}

export function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yy}${mm}${dd}-${hh}${mi}`;
  } catch {
    return iso;
  }
}

export function identifierForEvent(event: MEvent, unit?: Unit, strain?: Strain): string {
  return buildIdentifier({
    functionCode: event.functionCode,
    type: unit?.type,
    eventTime: event.eventTime,
    strainCode: strain?.code ?? unit?.strainCode,
    unitCode: event.unitCode,
    strainDescription: strain?.description,
    unitDescription: unit?.description,
  });
}

export function identifierForUnit(unit: Unit, functionCode: FunctionCode = "COL", strain?: Strain): string {
  return buildIdentifier({
    functionCode,
    type: unit.type,
    eventTime: unit.batchTime,
    strainCode: unit.strainCode,
    unitCode: unit.code,
    strainDescription: strain?.description,
    unitDescription: unit.description,
  });
}