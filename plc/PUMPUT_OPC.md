# Pumput multi-instance OPC UA (1.11.2026)

Luku bridgen kautta (`~/opcua-bridge/config.yaml`):

| Instanssi | Polku |
|---|---|
| Sequence | `@*/Pumput_DB/Static/Sequence/*` |
| CircPump_L | `@*/Pumput_DB/Static/CircPump_L/*` |
| CircPump_R | `@*/Pumput_DB/Static/CircPump_R/*` |
| FertDose | `@*/Pumput_DB/Static/FertDose/*` |

MQTT: `Sensors/PLC_2/Sequence`, `Sensors/PLC_2/FertDose`.

Vanha `FB_FertDose_DB` on yhä OPC UA -puussa (Input.Enable/Heartbeat elää, Outputit `None`) – ei enää lukukohde.

## Kirjoitukset (odottaa lupaa)
- `Pumput_DB/Static/CircPump_L/Enable` (Bool)
- `Pumput_DB/Static/CircPump_R/Enable` (Bool)
- `Pumput_DB/Static/FertDose/Enable` (Bool)
- `Pumput_DB/Static/FertDose/DoseReq_ms` (Int32, 0–5000)
- `Pumput_DB/Static/FertDose/DoseTrig` (Bool pulse)
- `Pumput_DB/Static/FertDose/Heartbeat` (Int32 PLC:ssä; vanha DB oli UInt16)

Bridge `writes: {}` / backend `PLC_WRITE_ALLOWED=false` kunnes hyväksytty.
