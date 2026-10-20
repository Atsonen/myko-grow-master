import { useEffect, useState } from "react";
import { getTaxonomy } from "@/lib/apiClient";
import { KNOWN_LOCATIONS } from "@/lib/locations";

const FALLBACK_SUBSTRATES = ["BR", "BULK", "FCR", "GRAIN", "OAT", "RICE"];

/** Predefined locations and substrates from taxonomy_terms (the backend rejects anything else). */
export function useLookups() {
  const [locations, setLocations] = useState<string[]>(KNOWN_LOCATIONS);
  const [substrates, setSubstrates] = useState<string[]>(FALLBACK_SUBSTRATES);
  useEffect(() => {
    getTaxonomy()
      .then((t) => {
        if (t.locations?.length) setLocations(t.locations);
        if (t.substrates?.length) setSubstrates(t.substrates);
      })
      .catch(() => undefined);
  }, []);
  return { locations, substrates };
}
