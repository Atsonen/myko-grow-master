# Lannoiteannostelu – kevennetty jako (PLC FB_FertDose + Myko Valvomo)

**Tila: EHDOTUS.** Valvomo-puoli toimii dry-run-tilassa (kirjaa "WOULD DOSE"), ei OPC UA -kirjoituksia. Heartbeat-kirjoitinta ei ole kytketty.

## Työnjako
| PLC (FB_FertDose) | Valvomo (backend/src/fertDose.js) |
|---|---|
| Lannoitepumppu (yksi lähtö FertPump) päälle pyydetyksi ajaksi | EC (dl23) luku + luotettavuus (tuoreus, alue, piikit N näytteessä, yhtäjaksoinen validius) |
| Kova raja: pyyntö max 5000 ms, turvakatkaisu MIN(pyyntö+1 s, 5 s) | Ehto EC < TDS_SP yhtäjaksoisesti 10 min |
| Heartbeat-vahti (45 s) → pumppu heti pois | 20 min tauko annosten välillä |
| Enable (yksi bitti, korvaa ON + Dozing_ON) | Annoskoko (s, 1 s = 1 ml), lannoitevalinta A/B |
| Laskurit: DoseCount, LastDose_ms, RunTime_ms (retain) | Lannoitevalinta A/B (Myko-asetus), lokitus fert_dose_log, kumulatiivinen per lannoite, hälytykset |

Poistetaan PLC:stä: EC_Below TON / EC-vertailu, 20 min FertPumpDelay, tilakone 0..3, FertsJalj_% -laskenta (FillingOnTime_A), FertsFilled-kuittaus, hälytykset.

## Lannoite A/B
Sama pumppu ja letku; letku siirretään käsin säiliöstä toiseen. Valinta on vain Myko-asetus (`fert_dose.fert`, vaihdettavissa Kasvamo-näkymässä), joka kirjataan jokaiselle annokselle `fert_dose_log.fert`. Lannoitekohtainen kumulatiivinen aika lasketaan Mykossa lokista; PLC:n RunTime_ms on pumpun kokonaisaika.

## OPC UA -muuttujat (FertDose_DB)
| Muuttuja | Tyyppi | Suunta | Writable | Kuvaus |
|---|---|---|---|---|
| Enable | Bool | Valvomo→PLC | ✔ | Annostelu sallittu |
| DoseReq_ms | DInt | Valvomo→PLC | ✔ | Pyydetty annos ms |
| DoseTrig | Bool | Valvomo→PLC | ✔ | Nouseva reuna käynnistää, Valvomo palauttaa FALSE |
| Heartbeat | UInt | Valvomo→PLC | ✔ | Kasvatetaan ~5 s välein |
| DoseActive | Bool | PLC→Valvomo | – | Käynnissä |
| DoseDone | Bool | PLC→Valvomo | – | 1 kierroksen pulssi (käytä DoseCount) |
| DoseCount | UDInt | PLC→Valvomo | – | Annoslaskuri (retain) |
| LastDose_ms | DInt | PLC→Valvomo | – | Toteutunut aika |
| RunTime_ms | UDInt | PLC→Valvomo | – | Kumulatiivinen pumpun käyntiaika (retain) |
| HB_OK | Bool | PLC→Valvomo | – | Heartbeat kunnossa |
| Status | Int | PLC→Valvomo | – | 0 idle, 1 active, 2 done, 3 limited, 10 not enabled, 11 HB lost, 13 bad request, 14 aborted (Enable pois), 15 aborted (turvakatkaisu) |

## TIA-työt (käyttäjä)
1. External source files → Add `FB_FertDose.scl`, `FertDose_DB.db` → "Generate blocks from source".
2. FertDose_DB: Accessible/Visible from HMI/OPC UA kaikille; **Writable** vain Enable, DoseReq_ms, DoseTrig, Heartbeat.
3. Lisää FertDose_DB OPC UA server interfaceen (esim. "Controls", jossa Pumput_DB) tai salli standard-DB-näkyvyys.
4. Tagitaulu: `FertPump` fyysiseen lähtöön (vanhan FertPumps-lähdön osoite).
5. OB1: lisää kutsu (`OB1_FertDose_call.scl`), poista vanha lannoitelogiikka/FertPumps-ohjaus (ettei kaksi logiikkaa ohjaa samaa lähtöä).
6. Compile + download + testaa: ilman heartbeatia HB_OK = FALSE → pumppu ei käy (turvallinen oletus).

## Valvomo
- API: `GET /api/fertdose` (tila, syy, viimeisimmät, kumulatiivinen), `PUT /api/fertdose/settings` (fert, dose_s, below_min, pause_min, spike_ppm, min_uptime_min, stale_s, sp_source plc/manual, sp_manual).
- Asetukset `myko_settings` k='fert_dose' (oletus live=false, hb_enabled=false). TDS_SP luetaan Pumput_DB:stä (/api/pumput).
- Loki `fert_dose_log` (ts UTC, fert, requested_ms, actual_ms, ec_before, ec_sp, reason, mode dry-run/live-blocked).
- UI: Kasvamo-näkymän alla rivi "Lannoiteannostelu" (vain luku).

## Hyväksyntää vaativat (go-live)
1. TIA-muutokset ja download PLC:lle (käyttäjä).
2. Bridgeen FertDose_DB-solmut (luku) + kirjoituskomennot Enable/DoseReq_ms/DoseTrig/Heartbeat.
3. Valvomon heartbeat-kirjoitin ja annospyyntökirjoitin (ei toteutettu tässä versiossa tarkoituksella) → live=true.
