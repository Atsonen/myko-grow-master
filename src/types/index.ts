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
  currentLocation?: string; // Current physical location, e.g. INCUBATOR-1, SHELF-A2, FRUITING-TENT.
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

export interface UnitLocationRecord {
  id: string;
  unitCode: string;
  location: string;
  movedAt: string; // ISO
  note?: string;
  archived?: boolean;
}

export interface EnvironmentReading {
  id: string;
  timestamp: string; // ISO
  location: string;
  source: string; // Sensor or MQTT topic/source name.
  temperatureC?: number;
  humidityRh?: number;
  co2Ppm?: number;
  note?: string;
  archived?: boolean;
}

export interface EnvironmentChannelMap {
  payloadKey: string; // e.g. DStemp1
  alias: string; // e.g. T1
  location: string; // e.g. TERRARIO-1
  metric: "temperatureC" | "humidityRh" | "co2Ppm";
  description?: string;
}

export interface EnvironmentSource {
  id: string;
  name: string;
  location: string;
  mqttTopic?: string;
  channelMap?: EnvironmentChannelMap[];
  description?: string;
  archived?: boolean;
}