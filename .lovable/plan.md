# Myko Valvomo — MVP Frontend Plan

A clickable React + TypeScript prototype for tracking mushroom cultivation: strains, containers, events, transfers, contamination, and lineage. No auth, no DB — mock data only, structured for a future API swap.

## Identifier Model

Format: `=FUNCTION/+TYPE/&EVENT_TIME/#STRAIN/@UNIT`

- FUNCTION: COL, FRU, OBS, QC, TRF, HAR, PREP
- TYPE: BOX, JAR, PD, LC, BAG, OTHER
- EVENT_TIME: ISO timestamp
- STRAIN: e.g. OST
- UNIT: e.g. BOX-260502-1

Generated centrally in `src/lib/identifier.ts` — never hard-coded.

## Design Direction

Industrial valvomo (control room) feel. Dark neutral background, high-contrast text, compact cards, mono font for identifiers, clear status accents:

- active = neutral (slate/blue)
- warning = amber
- contaminated = red
- harvested = green
- discarded / archived = muted gray

Built with shadcn (cards, tables, tabs, badges, dialogs, inputs, sheet) and Tailwind. Desktop-first, responsive.

## Routes

```
/                  Dashboard
/units             Units list
/units/$unitCode   Unit detail
/events            Global event timeline
/lineage           Lineage tree
/qc                QC / contamination
/events/new        Add event form
/transfers/new    Add transfer form
```

Shared layout in `__root.tsx` with sidebar nav (collapsible) + header showing app name and quick "Add event / Add transfer" buttons.

## Views

**1. Dashboard** — grid of compact stat + list cards:
- Active units count + by type
- Active grow boxes
- Recent observations (last 5)
- Contamination warnings
- Stale units (no event in N days)
- Recent transfers

**2. Units** — searchable, filterable table/cards. Filters: TYPE, STATUS, STRAIN. Columns: unit code, type, strain, status badge, batch time, latest event summary. Click row → unit detail.

**3. Unit detail** — header shows full generated identifier in mono. Metadata block. Tabs: Events timeline | Transfers (in/out) | Notes. Action buttons: Add observation, Add QC, Add transfer, Mark contaminated/discarded/harvested (open prefilled dialogs).

**4. Event timeline** — global chronological list. Search + FUNCTION filter chips. Each card: identifier, time, function badge, unit, strain, note, optional temp/humidity.

**5. Lineage** — nested tree view: Strain → LC → JAR → BOX → terminal events (HAR/QC/OBS). Contaminated/discarded branches highlighted red/muted. Pure CSS nested list with connector lines for MVP.

**6. QC / Contamination** — stat tiles (contaminated, discarded, active risky), filterable list of QC events grouped by severity tag (suspected, confirmed, bad smell, excess moisture, drying, discarded).

**7. Add event form** — fields: function_code, unit_code (combobox), event_time (default now), title, note, temperature_c, humidity_rh, optional status change. Live identifier preview as user fills it. Appends to mock store.

**8. Add transfer form** — fields: source_unit_code, target_unit_code (allow new), transfer_time, method, amount, note. Creates target unit if missing; logs a TRF event on both sides.

## Data Layer

Types in `src/types/index.ts`:

- `Strain { code, name, species, notes }`
- `Unit { code, type, strainCode, status, batchTime, parentUnitCode?, notes }`
- `Event { id, functionCode, unitCode, eventTime, title, note?, temperatureC?, humidityRh?, qcTags? }`
- `Transfer { id, sourceUnitCode, targetUnitCode, transferTime, method, amount, note? }`

Mock data in `src/data/mockData.ts`:
- Strain OST (oyster)
- 2–3 LC units, 3–4 JAR units, 1–2 PD units, 4–5 BOX units
- Transfers LC→JAR, JAR→BOX
- Observations + QC warnings sprinkled across timeline
- One harvested BOX, one contaminated branch (JAR→BOX both flagged)

State via a simple Zustand-style store or React context in `src/store/useDataStore.ts` so add-event/add-transfer mutations reflect across views during the session. API-swap point: replace store internals with fetch calls.

## File Structure

```
src/
  lib/identifier.ts            buildIdentifier(), parseIdentifier()
  types/index.ts
  data/mockData.ts
  store/useDataStore.ts        in-memory CRUD over mock data
  components/
    layout/AppSidebar.tsx
    layout/AppHeader.tsx
    common/IdentifierTag.tsx   mono badge rendering full id
    common/StatusBadge.tsx
    common/FunctionBadge.tsx
    units/UnitsTable.tsx
    units/UnitFilters.tsx
    events/EventCard.tsx
    events/EventTimeline.tsx
    lineage/LineageTree.tsx
    qc/QCStats.tsx
    forms/AddEventForm.tsx
    forms/AddTransferForm.tsx
  routes/
    __root.tsx                  sidebar layout
    index.tsx                   dashboard
    units.tsx                   list
    units.$unitCode.tsx         detail
    events.tsx
    events.new.tsx
    lineage.tsx
    qc.tsx
    transfers.new.tsx
```

## Out of Scope (MVP)

- Authentication / user roles
- Real backend / database
- File uploads / photos
- Multi-strain advanced analytics
- Mobile-optimized layouts beyond responsive basics

After approval I'll scaffold the types, mock data, identifier util, store, then build each route.
