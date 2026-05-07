import type { MEvent, Strain, Transfer, Unit } from "@/types";

export const strains: Strain[] = [
  {
    code: "OST",
    name: "Pearl Oyster",
    species: "Pleurotus ostreatus",
    description: "Pearl oyster, beginner-friendly",
    notes: "Reliable beginner strain. Wide temp tolerance.",
  },
];

// Helper to keep dates consistent (relative to now)
const day = (offset: number, h = 9, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const units: Unit[] = [
  // Liquid cultures
  { code: "LC-250909-1", type: "LC", strainCode: "OST", status: "ACTIVE", batchTime: day(-60), notes: "Mother LC, healthy mycelium clouds." },
  { code: "LC-251015-1", type: "LC", strainCode: "OST", status: "ACTIVE", batchTime: day(-40) },
  // Petri dishes
  { code: "PD-251005-1", type: "PD", strainCode: "OST", status: "ACTIVE", batchTime: day(-45), notes: "Isolation from LC-250909-1" },
  { code: "PD-251020-1", type: "PD", strainCode: "OST", status: "ARCHIVED", batchTime: day(-35) },
  // Jars
  { code: "JAR-260425-1", type: "JAR", strainCode: "OST", status: "ACTIVE", batchTime: day(-25), parentUnitCode: "LC-250909-1" },
  { code: "JAR-260425-2", type: "JAR", strainCode: "OST", status: "ACTIVE", batchTime: day(-25), parentUnitCode: "LC-250909-1" },
  { code: "JAR-260428-1", type: "JAR", strainCode: "OST", status: "CONTAMINATED", batchTime: day(-22), parentUnitCode: "LC-251015-1", notes: "Green mold on top layer." },
  { code: "JAR-260501-1", type: "JAR", strainCode: "OST", status: "ACTIVE", batchTime: day(-19), parentUnitCode: "LC-251015-1" },
  // Boxes
  { code: "BOX-260502-1", type: "BOX", strainCode: "OST", status: "ACTIVE", batchTime: day(-18), parentUnitCode: "JAR-260425-1" },
  { code: "BOX-260502-2", type: "BOX", strainCode: "OST", status: "ACTIVE", batchTime: day(-18), parentUnitCode: "JAR-260425-2" },
  { code: "BOX-260505-1", type: "BOX", strainCode: "OST", status: "CONTAMINATED", batchTime: day(-15), parentUnitCode: "JAR-260428-1", notes: "Spread from JAR-260428-1." },
  { code: "BOX-260420-1", type: "BOX", strainCode: "OST", status: "HARVESTED", batchTime: day(-30), parentUnitCode: "JAR-260425-1", notes: "Yielded 480g first flush." },
  { code: "BOX-260510-1", type: "BOX", strainCode: "OST", status: "ACTIVE", batchTime: day(-10), parentUnitCode: "JAR-260501-1" },
];

let eId = 0;
const e = (
  functionCode: MEvent["functionCode"],
  unitCode: string,
  eventTime: string,
  title: string,
  extra: Partial<MEvent> = {},
): MEvent => ({
  id: `evt-${++eId}`,
  functionCode,
  unitCode,
  eventTime,
  title,
  ...extra,
});

export const events: MEvent[] = [
  e("PREP", "JAR-260425-1", day(-26), "Pressure cooker 90 min @ 15 psi"),
  e("PREP", "JAR-260425-2", day(-26), "Pressure cooker 90 min @ 15 psi"),
  e("COL", "JAR-260425-1", day(-25), "Inoculated from LC-250909-1"),
  e("COL", "JAR-260425-2", day(-25), "Inoculated from LC-250909-1"),
  e("OBS", "JAR-260425-1", day(-18), "30% colonization, healthy white", { temperatureC: 23.5, humidityRh: 60 }),
  e("COL", "JAR-260428-1", day(-22), "Inoculated from LC-251015-1"),
  e("QC", "JAR-260428-1", day(-12), "Green mold spotted on surface", {
    qcTags: ["CONTAMINATION_CONFIRMED", "BAD_SMELL"],
    statusChange: "CONTAMINATED",
    note: "Trichoderma. Isolate from rack.",
  }),
  e("FRU", "BOX-260502-1", day(-18), "Moved to fruiting chamber", { temperatureC: 21, humidityRh: 88 }),
  e("FRU", "BOX-260502-2", day(-18), "Moved to fruiting chamber", { temperatureC: 21, humidityRh: 88 }),
  e("OBS", "BOX-260502-1", day(-7), "Pinning started, several primordia", { temperatureC: 20.5, humidityRh: 90 }),
  e("OBS", "BOX-260502-2", day(-5), "Slow pinning, increased FAE", { temperatureC: 20, humidityRh: 92 }),
  e("QC", "BOX-260505-1", day(-8), "Suspicious dark patches", {
    qcTags: ["CONTAMINATION_SUSPECTED", "EXCESSIVE_MOISTURE"],
    note: "Watch closely.",
  }),
  e("QC", "BOX-260505-1", day(-4), "Confirmed contamination", {
    qcTags: ["CONTAMINATION_CONFIRMED"],
    statusChange: "CONTAMINATED",
  }),
  e("HAR", "BOX-260420-1", day(-12), "First flush harvested 480g", { statusChange: "HARVESTED" }),
  e("OBS", "BOX-260510-1", day(-2), "Full colonization, ready for fruiting", { temperatureC: 24, humidityRh: 65 }),
  e("OBS", "LC-250909-1", day(-3), "Strong mycelium growth, no sediment"),
];

let tId = 0;
const t = (
  sourceUnitCode: string,
  targetUnitCode: string,
  transferTime: string,
  method: string,
  amount: string,
  note?: string,
): Transfer => ({
  id: `trf-${++tId}`,
  sourceUnitCode,
  targetUnitCode,
  transferTime,
  method,
  amount,
  note,
});

export const transfers: Transfer[] = [
  t("LC-250909-1", "JAR-260425-1", day(-25), "Syringe injection", "5 ml"),
  t("LC-250909-1", "JAR-260425-2", day(-25), "Syringe injection", "5 ml"),
  t("LC-251015-1", "JAR-260428-1", day(-22), "Syringe injection", "5 ml"),
  t("LC-251015-1", "JAR-260501-1", day(-19), "Syringe injection", "5 ml"),
  t("JAR-260425-1", "BOX-260502-1", day(-18), "Grain to bulk (G2B)", "1 jar / 5 L substrate"),
  t("JAR-260425-2", "BOX-260502-2", day(-18), "Grain to bulk (G2B)", "1 jar / 5 L substrate"),
  t("JAR-260428-1", "BOX-260505-1", day(-15), "Grain to bulk (G2B)", "1 jar / 5 L substrate", "Risky, source had suspicious smell."),
  t("JAR-260425-1", "BOX-260420-1", day(-30), "Grain to bulk (G2B)", "1 jar / 5 L substrate"),
  t("JAR-260501-1", "BOX-260510-1", day(-10), "Grain to bulk (G2B)", "1 jar / 5 L substrate"),
];