# Pumput multi-instance OPC UA (1.11.2026)

Luku + hyväksytyt kirjoitukset (`~/opcua-bridge/config.yaml`, lupa 1.11.2026 15:46):

| Instanssi | Polku |
|---|---|
| Sequence | `@*/Pumput_DB/Static/Sequence/*` (vain luku) |
| CircPump_L | `@*/Pumput_DB/Static/CircPump_L/*` |
| CircPump_R | `@*/Pumput_DB/Static/CircPump_R/*` |
| FertDose | `@*/Pumput_DB/Static/FertDose/*` |

MQTT: `Sensors/PLC_2/Sequence`, `Sensors/PLC_2/FertDose`.

## Kirjoituswhitelist
- `CircPump_L/Enable`, `CircPump_R/Enable` (Bool) ← Myko/Cmd/CircPump
- `FertDose/Enable` (Bool)
- `FertDose/DoseReq_ms` (Int32, 500–5000)
- `FertDose/DoseTrig` (Bool pulse)
- `FertDose/Heartbeat` (Int32)

Vanha `FB_FertDose_DB` ei enää kirjoituskohde.
