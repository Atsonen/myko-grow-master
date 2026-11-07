# Garden_Light_DB – suora OPC UA (backend)

## Arkkitehtuuri

| Kerros | Toteutus |
|--------|----------|
| PLC | `Garden_Light_DB` @ `ServerInterfaces/Controls/` |
| Backend | `node-opcua` poll (`fbLightOpcUa.js`) — **ei lighting-MQTT:ä** |
| UI | `/api/light` → prosessikuva chip + faceplate |
| Hälytys | `fbLight.js` → `/api/alarms/summary` |

Ulkoista opcua-bridge-muutosta valaistukselle **ei tarvita**. Muu MQTT/bridge säilyy ennallaan.

## OPC (vahvistettu 2026-11-07)

- Endpoint: `opc.tcp://192.168.1.103:4840`
- Namespace URI `http://Controls` (nykyinen ns5)
- Browse: `ServerInterfaces/Controls/Garden_Light_DB`
- **ID drift:** `ns=5;i=1456` oli `Garden Temperature_Night` — käytä browse-nimeä + BrowseName-tarkistusta

### Kentät

**Input:** Init, Enable, Mode, OnHour, OffHour, LocalHour, ClockValid, HB_OK  
**Output:** LightOn, ConfigOK, ClockOK, ScheduleActive, Ready  
**Static:** Armed (näyttö); **ei** Watchdog/BaselineValid/LastCounter/SeenChange

**Kirjoitusallowlist:** Enable, Mode, OnHour, OffHour (Input)

## Deploy (Lubuntu `/home/atte/kehitys/myko`)

1. `cd backend && npm ci` (sis. `node-opcua`)
2. `npm run migrate` — lisää `myko_settings.fb_light` jos puuttuu (ei ylikirjoita)
3. Kopioi `deploy/myko-fb-light.env.example` → systemd env (`FB_LIGHT_OPC_CONNECT=1`)
4. Branch `deploy/lighting-a101dc7-20261107` tai uudempi commit, **ei merge täältä**
5. Käynnistä vain `myko-backend` paikallisesti — **älä** käynnistä opcua-bridgeä uudelleen tämän takia

`assistant.js` LABEL_PY — paikallinen, ei repossa.

## LIVE-validointi

- **Code-tested:** mock OPC -testit (`fbLightOpc.test.js`, `fbLight.test.js`)
- **PLC read:** käyttäjä Lubuntuilla `FB_LIGHT_OPC_CONNECT=1` — **ei testattu tästä VM:stä**

Odotettu ensimmäinen live-read: Enable=false, Mode=0, LightOn=false, Ready=false, HB/config/clock OK → ei hälytystä.

## Konfig (myko_settings `fb_light`)

```json
{
  "opc_direct": true,
  "poll_s": 5,
  "groups": [{ "id": "garden", "label": "Garden_Light_DB", "enabled": true }],
  "opc": {
    "endpoint": "opc.tcp://192.168.1.103:4840",
    "interfaces_id": "ServerInterfaces",
    "interface_name": "Controls",
    "controls_ns_uri": "http://Controls",
    "db_browse_name": "Garden_Light_DB"
  }
}
```

Migrate täyttää tämän automaattisesti ensimmäisellä ajolla.
