# FB_CircPump – kiertovesipumppu (S7-1200, SCL)

Lähde: `FB_CircPump.scl` (TIA Portal V17+, External source → *Generate blocks from source*).
Optimoitu lohko, ei globaaleja DB:itä, IEC-ajastimet (TON_TIME, R_TRIG) multi-instansseina.
Yksi FB, **yksi instanssi per pumppu**. Sekvenssivertailu tehdään FB:n ulkopuolella.

## Kutsu (esim. OB1 / sekvenssi-FB)

```scl
"CircPump1_DB"(Run := "Seq".Step = 3,
               Ack := "CircPump_Ack",
               Pump => "CircPump1");

"CircPump2_DB"(Run := "Seq".Step = 5,
               Ack := "CircPump_Ack",
               Pump => "CircPump2");

// Sekvenssin siirtymä: oma ehto TAI pumppu-FB ilmoittaa askeleen valmiiksi (vika/ohitus/pois)
IF "Seq".Step = 3 AND ("Seq".Step3Ready OR "CircPump1_DB".Done) THEN
    "Seq".Step := 4;
END_IF;
```

Parametrit joita ei kytketä kutsuun (Enable, MaxRun, MinOff, UseFeedback, FbDelay) jäävät
instanssi-DB:n arvoiksi → asetettavissa TIA:sta tai myöhemmin Valvomosta OPC UA:lla
(merkitty `S7_SetPoint`; tarkista *Accessible from HMI/OPC UA* + *Writable* instanssi-DB:ssä).
Älä kytke kutsuun parametria, jota halutaan kirjoittaa ulkoa (kutsu ylikirjoittaa sen joka kierros).

## Rajapinta

| Tulo | Tyyppi | Oletus | Kuvaus |
|---|---|---|---|
| Run | Bool | – | Sekvenssiaskel aktiivinen → pumppu käy |
| Enable | Bool | TRUE | FALSE = käsin pois (pumppu pois, Run kuitataan Done=TRUE) |
| Ack | Bool | – | Vian kuittaus nousevalla reunalla |
| MaxRun | Time | T#30M | Maksimikäyntiaika yhdellä käynnillä |
| UseFeedback | Bool | FALSE | Valvotaanko käyntitietoa |
| Feedback | Bool | – | Käyntitieto (kontaktori/virta/virtaus) |
| FbDelay | Time | T#5S | Käyntitiedon sallittu viive / katkos |
| MinOff | Time | T#0S | Minimi seisonta-aika ennen uutta käynnistystä |

| Lähtö | Tyyppi | Kuvaus |
|---|---|---|
| Pump | Bool | Fyysinen lähtö |
| Running | Bool | Pumppu ohjattu päälle |
| Done | Bool | FB on lopettanut askeleen: vika (lukittu kunnes Ack) tai Enable=FALSE (Run päällä). **Normaali lopetus (Run → FALSE) ei aseta Donea** – sekvenssi omistaa normaalin askeleen keston. |
| Error | Bool | Vika lukittu (MaxRun tai käyntitieto) |
| Skipped | Bool | Vikatilassa tuli uusi Run-pyyntö → ohitettu (lukittu vian kanssa) |
| Waiting | Bool | Run päällä, odotetaan MinOff-aikaa |
| LastRun_ms | DInt | Viimeisimmän/nykyisen käynnin kesto |
| RunTime_ms | UDInt | Kumulatiivinen käyntiaika (retain) |
| StartCount | UDInt | Käynnistyslaskuri (retain) |
| ErrCode | Int | 0 ok, 1 MaxRun ylitetty, 2 käyntitieto puuttuu |
| Status | Word | Bitit alla |

### Status-bitit

| Bitti | Merkitys |
|---|---|
| 0 | Running |
| 1 | Done |
| 2 | Error |
| 3 | Skipped |
| 4 | Vika: MaxRun ylitetty |
| 5 | Vika: käyntitieto puuttuu |
| 6 | Waiting (MinOff) |
| 7 | Disabled (Enable = FALSE) |
| 8 | Estetty: kuitattu Run=TRUE aikana, odottaa Run-laskua |
| 9 | Run-tulo |
| 10 | Käyntitieto päällä (kun UseFeedback) |

## Toimintataulukko

| Tilanne | Pump | Done | Error | Skipped | Huom. |
|---|---|---|---|---|---|
| Run=FALSE, ei vikaa | 0 | 0 | 0 | 0 | Lepo |
| Run=TRUE, Enable, ei vikaa | 1 | 0 | 0 | 0 | Käy; LastRun_ms kasvaa |
| Run TRUE → FALSE | 0 | 0 | 0 | 0 | Normaali lopetus |
| Käynti ≥ MaxRun | 0 | **1 lukittu** | **1 lukittu** | 0 | ErrCode 1; sekvenssi jatkaa Donella |
| UseFeedback & ei käyntitietoa > FbDelay | 0 | 1 lukittu | 1 lukittu | 0 | ErrCode 2 |
| Vikatilassa uusi Run (nouseva reuna) | 0 | 1 | 1 | **1** | Askel ohitetaan heti |
| Ack ↑, Run=FALSE | 0 | 0 | 0 | 0 | Valmis seuraavaan Run-pyyntöön |
| Ack ↑, Run=TRUE | 0 | 0 | 0 | 0 | Estetty (bit 8) kunnes Run → FALSE; ei käynnisty kesken askeleen |
| Enable=FALSE, Run=TRUE | 0 | 1 (ei lukitu) | 0 | 0 | Käsin pois; Done niin kauan kuin Run päällä |
| Run=TRUE, MinOff kesken | 0 | 0 | 0 | 0 | Waiting=1, käynnistyy MinOffin jälkeen (MaxRun ei juokse) |

Huom:
- Vika säilyy CPU:n STOP→RUN yli vain jos instanssi-DB:n `sError` asetetaan retainiksi (oletus: ei retain → vika nollautuu käynnistyksessä, laskurit säilyvät).
- MaxRun-aika lasketaan pumpun käynnistä (ei Run-pyynnöstä), joten MinOff-odotus ei aiheuta vikaa.
- Valvomo-integraatio myöhemmin: vain luku (Status, RunTime_ms, StartCount, ErrCode); kirjoitukset (Ack/Enable/MaxRun) vain erikseen hyväksyttyinä.
