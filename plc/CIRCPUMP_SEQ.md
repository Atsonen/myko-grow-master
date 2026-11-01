# FB_Sequence – kiertovesisekvenssin runko (S7-1200, SCL)

`FB_Sequence.scl` – **tyhjä pohja**, ei ohjaa lähtöjä. Optimoitu, VERSION 0.1, ei globaaleja DB:itä.
Ei käännetty – tuo TIA:ssa *External source files → Generate blocks from source*.

## Rajapinta

| Tulo | Tyyppi | Oletus | Kuvaus |
|---|---|---|---|
| Enable | Bool | – | Sekvenssi sallittu |
| LeakAlarm | Bool | – | Kosteushälytys / vesivuoto → seis |
| Heartbeat | Bool | – | Valvomon toggle-bitti, **jätä kytkemättä** |
| HbTimeout | Time | T#45S | Ei muutosta tässä ajassa → HB_OK = FALSE |
| T_Circ | Time | T#30S | Askel 1 kesto (S7_SetPoint, jätä kytkemättä) |
| T_Settle | Time | T#10M | Askel 2 kesto (S7_SetPoint) |
| ~~T_Fill~~ | — | poistettu | Askel 4 etenee **FillPump.Done**:lla |

| Lähtö | Tyyppi | Kuvaus |
|---|---|---|
| Step | Int | Nykyinen askel (instanssi-DB, luettavissa OPC UA:lla) |
| StepTime_ms | DInt | Aika nykyisessä askeleessa |
| HB_OK | Bool | Heartbeat kunnossa (vaatii vähintään yhden muutoksen käynnistyksen jälkeen) |
| Stopped | Bool | NOT Enable OR LeakAlarm OR NOT HB_OK |
| CycleCount | DInt | Valmiit kierrokset |

## Askeleet

| Step | Nimi | Siirtymä | Tuleva toiminta |
|---|---|---|---|
| 0 | Seis | Enable AND NOT LeakAlarm AND HB_OK → 1 | – |
| 1 | Kierrätys | T_Circ kulunut → 2 | CircPump1/2 Run |
| 2 | Tasaantuminen | T_Settle kulunut → 3 | pumput pois |
| 3 | Pinnan tallennus | yksi kierros → 4 | tallenna pinta |
| 4 | Täyttö | FillPump.Done → 1, CycleCount + 1 | FB_FillPump |

Yleinen pysäytys tarkistetaan ennen CASEa joka kierros → Step := 0. Tuntematon askel → 0.
Jokaisella ajastetulla askeleella oma TON (IN := Step = n) → nollautuu varmasti askeleen vaihtuessa.

## Kutsu

```scl
"FB_Sequence_DB"(Enable    := "Seq_Enable",
                 LeakAlarm := "A_HumHH");
// Heartbeat, HbTimeout, T_Circ, T_Settle, T_Fill jätetään kytkemättä -> Valvomo kirjoittaa OPC UA:lla
// (instanssi-DB: Accessible from HMI/OPC UA + Writable). Kytketty parametri ylikirjoittuu joka kierros.

"CircPump1_DB"(Run := "FB_Sequence_DB".Step = 1, Ack := "CircPump_Ack", Pump => "CircPump1");
"CircPump2_DB"(Run := "FB_Sequence_DB".Step = 1, Ack := "CircPump_Ack", Pump => "CircPump2");
```

Jos pumppujen vika/ohitus halutaan siirtymäehdoksi, lisää askeleeseen 1 esim. tulo `PumpsDone`
(`"CircPump1_DB".Done AND "CircPump2_DB".Done`) ja ehto `#sTonCirc.Q OR #PumpsDone`.
