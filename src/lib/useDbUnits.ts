import { useEffect, useState } from "react";
import { getTaxonomy, getUnits } from "@/lib/apiClient";
import type { Unit } from "@/types";
import type { Taxonomy } from "@/store/useDataStore";

const FALLBACK: Taxonomy = { functions: ["COL", "FRU", "OBS", "QC", "TRF", "HAR", "PREP", "INOC"], types: ["BOX", "JAR", "PD", "LC", "BAG", "OTHER"],
  statuses: ["ACTIVE", "CONTAMINATED", "DISCARDED", "HARVESTED", "ARCHIVED"], qcTags: [] };

/** Units + taxonomy from the database (not the legacy localStorage store). */
export function useDbUnits() {
  const [units, setUnits] = useState<Unit[]>([]);
  const [taxonomy, setTaxonomy] = useState<Taxonomy>(FALLBACK);
  useEffect(() => {
    getUnits().then((u) => setUnits(u.filter((x) => !x.hidden))).catch(() => undefined);
    getTaxonomy().then((t) => setTaxonomy({ ...FALLBACK, ...t, functions: t.functions?.length ? t.functions : FALLBACK.functions })).catch(() => undefined);
  }, []);
  return { units, taxonomy };
}
