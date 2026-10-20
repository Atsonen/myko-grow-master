# Myko bulk API (for chat-driven changes)

Base URL on the Lubuntu host: `http://127.0.0.1/api` (nginx → backend :3010). All bodies are JSON.

## Common rules
- **Atomic**: every call is one DB transaction. Any error (unknown unit, bad value, `expectCount` mismatch)
  rolls back everything; the response is `{"error": "..."}` and nothing changes.
- **dryRun**: `"dryRun": true` (or `?dryRun=true`) runs the exact same statements and then rolls back.
  The response lists exactly which units would change (`units[].before/after/changed`) and, for bulk create,
  the exact codes that would be assigned. `operationId` is `null` in dry runs; no audit rows remain.
- **source**: `"source": "chat" | "ui" | "api" | "script"` (default `api`). It is written as `actor` on every
  `audit_log` row produced by the call, together with the call's `operation_id`.
- **Selection** (bulk-location, bulk-hide, events/bulk, units/select): give **either**
  - `"unitCodes": ["261013-JAR-1", ...]`, **or**
  - `"filter": { ... }` with at least one criterion:

| filter key | meaning |
|---|---|
| `status` | `"ACTIVE"` or list, e.g. `["ACTIVE","CONTAMINATED"]` |
| `location` | current location, string or list; `"NONE"`/`null` = no location yet |
| `type` | `JAR`, `BOX`, `LC`, `PD`, `BAG`, `OTHER` (string or list) |
| `substrate` | e.g. `FCR`, `OAT`, `GRAIN`, `BULK` |
| `codePrefix` | e.g. `"261013-JAR"` |
| `batchFrom` / `batchTo` | ISO timestamps, `batchFrom <= batch_time < batchTo` |
| `includeHidden` | default `false` (hidden units are excluded) |
| `order` | `batch_asc` (default, oldest first), `batch_desc`, `code_asc`, `code_desc` |
| `limit` | 1..1000 – e.g. "ten jars" → `limit: 10` |
| `expectCount` | safety: fail unless exactly this many units match |

Recommended chat flow: **1)** `POST /units/select` or the action with `dryRun:true`, show the list to the user,
**2)** repeat the identical call without `dryRun` (add `expectCount` = the confirmed count so the set cannot drift).

## Endpoints

### Preview a selection
```bash
curl -s -X POST http://127.0.0.1/api/units/select -H 'Content-Type: application/json' \
  -d '{"filter":{"type":"JAR","location":"TERRARIO-1","status":"ACTIVE","limit":10}}'
```

### Bulk move / set location — `POST /api/units/bulk-location`
Body: selection + `location` (required) + `movedAt?` (ISO, default now) + `note?`. Units already at the target are reported as `unchanged`.
```bash
# "move ten jars from TERRARIO-1 to GARDEN" – dry run, then real with expectCount
curl -s -X POST http://127.0.0.1/api/units/bulk-location -H 'Content-Type: application/json' \
  -d '{"filter":{"type":"JAR","location":"TERRARIO-1","status":"ACTIVE","limit":10},"location":"GARDEN","source":"chat","dryRun":true}'
curl -s -X POST http://127.0.0.1/api/units/bulk-location -H 'Content-Type: application/json' \
  -d '{"filter":{"type":"JAR","location":"TERRARIO-1","status":"ACTIVE","limit":10,"expectCount":10},"location":"GARDEN","source":"chat"}'
```

### Bulk hide / unhide — `POST /api/units/bulk-hide`
Body: selection + `hidden` (`true` default / `false`). Visibility only; status and history untouched. For `hidden:false` the filter automatically includes hidden units.
```bash
curl -s -X POST http://127.0.0.1/api/units/bulk-hide -H 'Content-Type: application/json' \
  -d '{"filter":{"status":["DISCARDED","CONTAMINATED"],"batchTo":"2025-01-01T00:00:00Z"},"hidden":true,"source":"chat","dryRun":true}'
```

### Bulk event — `POST /api/events/bulk`
Body: selection + `functionCode` + `title` + `eventTime?` + `note?` +
`statusChange?` (`CONTAMINATED`,`DISCARDED`,`HARVESTED`,`ARCHIVED`,`ACTIVE`) + `temperatureC?` + `humidityRh?`.
Each unit gets its own event row; all share one `operation_id`.

| functionCode | meaning |
|---|---|
| `PREP` | preparation: sterilization / pasteurization / boiling of substrate |
| `INOC` | **inoculation (Inokulaatio)** – spores/LC/grain introduced into the unit |
| `COL` | colonization progress (mycelium growth, % colonized) |
| `FRU` | fruiting: moved to fruiting conditions, pins/primordia |
| `HAR` | harvest (flush, weight) |
| `OBS` | general observation |
| `QC` | quality control / contamination check (often with `statusChange`) |
| `TRF` | transfer / move of material between units (spawn-to-bulk, LC to LC) |

Unknown codes are rejected (the list comes from `taxonomy_terms` category `functions`).
Inoculation: add `sourceUnitCode` (+ `method?`, `amount?`) → each unit also gets a transfer and the source as a parent origin.
```bash
curl -s -X POST http://127.0.0.1/api/events/bulk -H 'Content-Type: application/json' \
  -d '{"filter":{"codePrefix":"261013-JAR"},"functionCode":"PREP","title":"Sterilized 90 min","source":"chat","dryRun":true}'
curl -s -X POST http://127.0.0.1/api/events/bulk -H 'Content-Type: application/json' \
  -d '{"unitCodes":["261013-JAR-1","261013-JAR-2"],"functionCode":"INOC","title":"INO 1 ml","sourceUnitCode":"260418-LC-1","amount":"1 ml","source":"chat"}'
```

### Bulk create — `POST /api/units/bulk`
Body: `base` (`YYMMDD-TYPE`; `FCR/OAT/BR/GS/RIS` mean JAR + that substrate) + `count` (1..200) + `strainCode?`
(omit = inherited from parent / none) + `status?` + `batchTime?` (default 12:00 Helsinki of the code date) +
`location?` + `origins?` + `substrate?` + `notes?`. Sequence numbers continue after the current max for that prefix.
Origins: `[{"type":"UNIT","parentUnitCode":"260418-LC-1"}]` or `[{"type":"SPORES"|"PURCHASED"|"STRAIN_LIBRARY"|"OTHER"|"UNKNOWN","note":"..."}]`.
```bash
curl -s -X POST http://127.0.0.1/api/units/bulk -H 'Content-Type: application/json' \
  -d '{"base":"261021-FCR","count":10,"location":"TERRARIO-1","origins":[{"type":"UNIT","parentUnitCode":"260418-LC-1"}],"source":"chat","dryRun":true}'
```

### Reading back
- `GET /api/units` – all units with `origins`, `effectiveStrainCode`, `hidden`, `currentLocation`
- `GET /api/units/:code/trace` – ancestors, descendants, timeline, environment summary
- `GET /api/units/:code/export?format=csv|json` – traceability export
- `GET /api/audit?operationId=op-...` – everything one call changed (also `?unitCode=`)

### Undo
There is no hard delete. Revert with an opposite call: move back (`bulk-location`), `bulk-hide` with `hidden:false`,
or a new event with the previous `statusChange`. The audit log keeps both.
