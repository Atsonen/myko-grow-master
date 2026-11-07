# FB_Light – Garden_Light_DB (CPU1215C)

## LIVE-tila (2026-11-07 16:09 EET)

| Kerros | Tila |
|--------|------|
| OPC UA publish (Garden_Light_DB) | **Vahvistettu** browse-polulla |
| MQTT `Sensors/PLC_2/Garden_Light` | **Puuttuu** (passiivinen tarkistus) |
| opcua-bridge mapping | **Puuttuu** repossa / tuotannon `/home/atte/opcua-bridge` |
| Myko UI + backend API | Valmis, commissioning (EI LIVE) |
| End-to-end ohjaus | **Estetty** – ei bridge Cmd + ei myko_settings mqtt |

Endpoint: `opc.tcp://192.168.1.103:4840`, Controls `http://Controls` ns5.

Browse: `ServerInterfaces/Controls/Garden_Light_DB` (BrowseName **Garden_Light_DB**).

**ID drift:** `ns=5;i=1456` oli aiemmin `Garden Temperature_Night`. Käytä browse-polkuja; numeric id vain informational.

### Vahvistetut jäsenet (luku)

| Ryhmä | Jäsen | Tyyppi | Esimerkki |
|-------|-------|--------|-----------|
| Input | Init, Enable, ClockValid, HB_OK | Bool | Enable=false, HB_OK=true |
| Input | Mode, OnHour, OffHour, LocalHour | Int16 | Mode=0, LocalHour=16 |
| Output | LightOn, ConfigOK, ClockOK, ScheduleActive, Ready | Bool | LightOn=false, Ready=false |
| Static | Armed | Bool | false |
| Static | Watchdog, BaselineValid, … | — | **Ei UI / ei kirjoita** |

Kirjoitusallowlist (app): **Enable, Mode, OnHour, OffHour** — ei outputs/statics/Init/HB/kello.

Odotettu commissioning UI: Enable=false, Mode 0, LightOn=false, Ready=false, HB/config/clock OK → **ei hälytystä**.

## Myko

- Backend: `backend/src/fbLight.js` (MQTT contract validation, hälytykset vain Enable=true + commissioned)
- UI: prosessikuvan vasen ylä (chip) + faceplate (`LightFaceplate.tsx`)
- Asetus: `myko_settings.k = fb_light` — ehdotus: `deploy/myko_settings/fb_light.proposed.json` (**älä ota käyttöön** ennen bridgea)
- Bridge snippet: `deploy/opcua-bridge/garden_light.verified-snippet.yaml`

## Ulkoiset toimet (ei tässä PR:ssä)

1. Lisää `topics: Sensors/PLC_2/Garden_Light` → `~/opcua-bridge/config.yaml` (snippet).
2. Laajenna bridge **Cmd** `Myko/Cmd/Garden_Light` (repo `bridge.py` tukee vain `pids` – sama työ kuin FertDose/FillPump tuotannossa).
3. INSERT/UPDATE `myko_settings` fb_light mqtt_sensor + mqtt_cmd.
4. Bridge restart (PID 1259 tms.) — **ei automaattista kirjoitusta testeissä**.

Täysi sanitisoitu JSON: `/home/atte/myko-light-opcua-discovery-20261107-1609.json` (paikallinen, ei repossa).
