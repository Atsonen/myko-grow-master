# Pumput multi-instance OPC UA (1.11.2026)

Luku + hyväksytyt kirjoitukset (`~/opcua-bridge/config.yaml`):

| Instanssi | Polku |
|---|---|
| Sequence | `@*/Pumput_DB/Static/Sequence/*` |
| CircPump_L | `@*/Pumput_DB/Static/CircPump_L/*` |
| CircPump_R | `@*/Pumput_DB/Static/CircPump_R/*` |
| FertDose | `@*/Pumput_DB/Static/FertDose/*` |
| TankLevel (pinta) | `@*/Pumput_DB/Static/LVL` (Float %, OPC-nimi **LVL**; ei `Sequence/Level`) |

MQTT: `Sensors/PLC_2/Sequence` (sis. `TankLevel` ← Static/LVL), `Sensors/PLC_2/FertDose`, `Sensors/PLC_2/Pumput` (LVL).

## Kirjoituswhitelist
- `CircPump_L/Enable`, `CircPump_R/Enable` (Bool) ← Myko/Cmd/CircPump (15:46)
- `Sequence/Enable` (Bool) ← Myko/Cmd/CircPump `{Enable}` (17:06) — vain Käynnistä/Pysäytä, **ei startup-synkkaa**
- `FertDose/Enable` (Bool)
- `FertDose/DoseReq_ms` (Int32, 500–5000)
- `FertDose/DoseTrig` (Bool pulse)
- `FertDose/Heartbeat` (Int32)

Vanha `FB_FertDose_DB` ei enää kirjoituskohde. `Sequence/Level` = askel 3:n tallenne, ei live-pinta.
