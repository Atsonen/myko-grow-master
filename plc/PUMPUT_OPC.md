# Pumput multi-instance OPC UA (1.11.2026)

Luku + hyväksytyt kirjoitukset (`~/opcua-bridge/config.yaml`):

| Instanssi | Polku |
|---|---|
| Sequence | `@*/Pumput_DB/Static/Sequence/*` |
| CircPump_L | `@*/Pumput_DB/Static/CircPump_L/*` |
| CircPump_R | `@*/Pumput_DB/Static/CircPump_R/*` |
| FertDose | `@*/Pumput_DB/Static/FertDose/*` |
| FillPump | `@*/Pumput_DB/Static/FillPump/*` (vain luku) |
| TankLevel (pinta, live) | `@*/Pumput_DB/Static/Level` (Float %) |
| LvlSnap (snapshot) | `@*/Pumput_DB/Static/LVL` (Float %, tasaantumisen jälkeen) |

MQTT: `Sensors/PLC_2/Sequence` (`TankLevel` ← Static/Level, `LvlSnap` ← Static/LVL, `Level` ← Sequence/Level), `Sensors/PLC_2/FertDose`, `Sensors/PLC_2/Pumput` (Level+LVL), `Sensors/PLC_2/FillPump` (vain luku).

## Kirjoituswhitelist
- `CircPump_L/Enable`, `CircPump_R/Enable` (Bool) ← Myko/Cmd/CircPump (15:46)
- `Sequence/Enable` (Bool) ← Myko/Cmd/CircPump `{Enable}` (17:06) — vain Käynnistä/Pysäytä, **ei startup-synkkaa**
- `FertDose/Enable` (Bool)
- `FertDose/DoseReq_ms` (Int32, 500–5000)
- `FertDose/DoseTrig` (Bool pulse)
- `FertDose/Heartbeat` (Int32)

Vanha `FB_FertDose_DB` ei enää kirjoituskohde. `Sequence/Level` = askel 3:n tallenne. Live-pinta = Static/Level; snapshot = Static/LVL.
