export type FunctionCode = "COL" | "FRU" | "OBS" | "QC" | "TRF" | "HAR" | "PREP";
export type ContainerType = "BOX" | "JAR" | "PD" | "LC" | "BAG" | "OTHER";
export type UnitStatus = "ACTIVE" | "CONTAMINATED" | "DISCARDED" | "HARVESTED" | "ARCHIVED";
export type QCTag =
  | "CONTAMINATION_SUSPECTED"
  | "CONTAMINATION_CONFIRMED"
  | "BAD_SMELL"
  | "EXCESSIVE_MOISTURE"
  | "DRYING"
  | "DISCARDED";

export interface Strain {
  code: string;
  name: string;
  species: string;
  description?: string;
  notes?: string;
  archived?: boolean;
}

export interface Unit {
  code: string;
  type: ContainerType;
  strainCode: string;
  status: UnitStatus;
  batchTime: string; // ISO
  parentUnitCode?: string;
  substrate?: string; // Material/substrate, e.g. BR, FCR, OAT, WBR, popcorn. Not part of +TYPE.
  description?: string;
  notes?: string;
}

export interface MEvent {
  id: string;
  functionCode: FunctionCode;
  unitCode: string;
  eventTime: string; // ISO
  title: string;
  description?: string;
  note?: string;
  temperatureC?: number;
  humidityRh?: number;
  qcTags?: QCTag[];
  statusChange?: UnitStatus;
  archived?: boolean;
}

export interface Transfer {
  id: string;
  sourceUnitCode: string;
  targetUnitCode: string;
  transferTime: string; // ISO
  method: string;
  amount: string;
  description?: string;
  note?: string;
  archived?: boolean;
}