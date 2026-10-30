/**
 * SensorBlock fan MQTT / command field names.
 * Keep in sync with backend/src/sensorBlock.js FAN_MQTT — rename keys here if firmware changes.
 */
export const FAN_MQTT = {
  mode: "FanMode",
  dutyPercent: "FanDutyPercent",
  rpmSetpoint: "FanRpmSetpoint",
  rpmActual: "FanRpm",
  pwm: "FanPWM",
  requestedPercent: "FanRequestedPercent",
  modePercent: "percent",
  modeRpm: "rpm",
  rpmMin: 0,
  rpmMax: 5500,
} as const;

export type FanControlMode = typeof FAN_MQTT.modePercent | typeof FAN_MQTT.modeRpm;

export const FAN_MODE_SCHEMA_MIN = 7;

export function parseFanMode(raw: unknown): FanControlMode | null {
  if (raw === FAN_MQTT.modePercent || raw === FAN_MQTT.modeRpm) return raw;
  return null;
}

export function parseFanRpmSetpoint(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.round(raw);
  if (n < FAN_MQTT.rpmMin || n > FAN_MQTT.rpmMax) return null;
  return n;
}
