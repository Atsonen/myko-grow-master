export type ApiEnvironmentReading = {
  id: number;
  timestamp: string;
  location: string;
  source: string;
  mqttTopic?: string;
  payloadKey?: string;
  alias?: string;
  temperatureC?: number;
  humidityRh?: number;
  co2Ppm?: number;
  note?: string;
  archived?: boolean;
};