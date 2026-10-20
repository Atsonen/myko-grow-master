// Event function codes with readable labels (EN / FI).
export const FUNCTION_LABELS: Record<string, string> = {
  PREP: "Preparation / sterilization – Valmistelu / sterilointi",
  INOC: "Inoculation – Inokulaatio",
  COL: "Colonization – Kolonisaatio",
  FRU: "Fruiting – Hedelmöinti",
  HAR: "Harvest – Sadonkorjuu",
  OBS: "Observation – Havainto",
  QC: "Quality control / contamination – Laadunvalvonta",
  TRF: "Transfer – Siirto",
};
export const FUNCTION_CODES = ["PREP", "INOC", "COL", "FRU", "HAR", "OBS", "QC", "TRF"] as const;
export const functionOptionLabel = (code: string) => (FUNCTION_LABELS[code] ? `${code} – ${FUNCTION_LABELS[code].split(" – ")[0]}` : code);
