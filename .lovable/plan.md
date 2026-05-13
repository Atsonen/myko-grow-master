## Tavoite

Tuoda Dashboardiin (`/`) uusi pieni paneeli, joka näyttää viimeisimmät lämpötilalukemat MariaDB:stä — käyttäen samaa backend-rajapintaa, jota Environment-sivu jo käyttää (`GET /api/environment/latest`).

## Mitä lisätään

Uusi kortti Dashboardin yläosaan, otsikko **"Latest temperatures"**. Yksi pieni laatta per location, jossa:
- location-koodi (esim. `TERRARIO-1`)
- alias jos saatavilla (pikku-pillerinä)
- lämpötila isolla (esim. `22.4 °C`)
- kosteus jos olemassa (`58 %RH`) ja relatiivinen aika (`2 min ago`)
- tila-indikaattori: connected / loading / error · viimeisin virheviesti

Päivitys 60 s välein samalla logiikalla kuin Environment-sivulla. Linkki kortin otsikossa → `/environment` täydelle näkymälle.

## Tekninen toteutus

**1. Uusi komponentti** `src/components/dashboard/LatestTemperaturesCard.tsx`
- Oma `useEffect` + `setInterval(60_000)` joka kutsuu `fetch("/api/environment/latest")`.
- Sisäinen tila: `readings`, `status` (`idle|loading|ok|error`), `error`.
- Tyyppi `ApiEnvironmentReading` siirretään jaettavaksi tiedostoon `src/types/environment.ts` ja importataan sekä uudessa kortissa että `routes/environment.tsx`:ssä (poistetaan duplikaatti).
- Renderöi vain lukemat joilla `temperatureC !== undefined`. Tyhjä tila: "No DB readings yet".
- Käyttää olemassa olevia tokeneita (`bg-card border-border`, `font-mono`, `text-muted-foreground`) — ei uusia värejä.

**2. Dashboard-integraatio** `src/routes/index.tsx`
- Lisätään `<LatestTemperaturesCard />` uudeksi gridi-kortiksi olemassa olevan kortti-gridin alkuun (saman `grid` sisään, kattaa esim. `md:col-span-2 xl:col-span-3` koko leveydeltä, tai tavallinen yhden kortin koko jos kompakti riittää — toteutetaan kompaktina yhden kortin kokoisena, jolloin se sijoittuu luontevasti muiden korttien joukkoon).

**3. Ei muutoksia backendiin** — `/api/environment/latest` palauttaa jo tarvittavat kentät. Vite proxy / sama origin -oletus toimii kuten Environment-sivulla nyt.

## Mitä EI muuteta

- Backend-koodi, MariaDB-skeema, MQTT-loggeri.
- Environment-sivun toiminta (vain ApiEnvironmentReading-tyyppi siirtyy jaettuun tiedostoon, käyttäytyminen ennallaan).
- `useEnvironmentStore` (paikallinen fallback ennallaan Environment-sivulla).

## Avoin kysymys (toteutan oletuksella, kerro jos toinen)

Näytetäänkö **kaikki** locationit joilla on lämpötila vai vain top-N (esim. 4)? Oletus: kaikki, koska niitä on tällä hetkellä vain pari (TERRARIO-1, KYLMASAILYTYSTILA-1).