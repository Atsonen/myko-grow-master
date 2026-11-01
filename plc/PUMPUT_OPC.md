# Pumput multi-instance OPC UA (1.11.2026)

Luku + hyväksytyt kirjoitukset (`~/opcua-bridge/config.yaml`):

| Instanssi | Polku |
|---|---|
| Sequence | `@*/Pumput_DB/Static/Sequence/*` |
| CircPump_L | `@*/Pumput_DB/Static/CircPump_L/*` |
| CircPump_R | `@*/Pumput_DB/Static/CircPump_R/*` |
| FertDose | `@*/Pumput_DB/Static/FertDose/*` |
| FillPump | `@*/Pumput_DB/Static/FillPump/*` (luku + hyväksytyt Cfg_*/Cmd_Ack) |
| TankLevel (pinta, live) | `@*/Pumput_DB/Static/Level` (Float %) |
| LvlSnap (snapshot) | `@*/Pumput_DB/Static/LVL` (Float %, tasaantumisen jälkeen) |

MQTT: `Sensors/PLC_2/Sequence` (`TankLevel` ← Static/Level, `LvlSnap` ← Static/LVL, `Level` ← Sequence/Level), `Sensors/PLC_2/FertDose`, `Sensors/PLC_2/Pumput` (Level+LVL), `Sensors/PLC_2/FillPump` + `Myko/Cmd/FillPump` (Cfg_Enable, Cfg_LvlSP 0–100, Cfg_Hyst 0–20, Cfg_MaxRun_s 10–3600, Cfg_LvlMin/Max 0–100, Cmd_Ack TRUE; ei startup-synkkaa).

## Kirjoituswhitelist
- `CircPump_L/Enable`, `CircPump_R/Enable` (Bool) ← Myko/Cmd/CircPump (15:46)
- `Sequence/Enable` (Bool) ← Myko/Cmd/CircPump `{Enable}` (17:06) — vain Käynnistä/Pysäytä, **ei startup-synkkaa**
- `FertDose/Enable` (Bool)
- `FertDose/DoseReq_ms` (Int32, 500–5000)
- `FertDose/DoseTrig` (Bool pulse)
- `FertDose/Heartbeat` (Int32)
- `FillPump/Cfg_Enable` (Bool)
- `FillPump/Cfg_LvlSP` (Float 0–100)
- `FillPump/Cfg_Hyst` (Float 0–20)
- `FillPump/Cfg_MaxRun_s` (Int32 10–3600)
- `FillPump/Cfg_LvlMin`, `FillPump/Cfg_LvlMax` (Float 0–100)
- `FillPump/Cmd_Ack` (Bool TRUE; PLC nollaa)

Vanha `FB_FertDose_DB` ei enää kirjoituskohde. `Sequence/Level` = askel 3:n tallenne. Live-pinta = Static/Level; snapshot = Static/LVL.

`Sequence/T_Fill` poistettu PLC:stä (1.11.2026); askel 4 = FillPump.Done.
