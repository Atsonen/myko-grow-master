# Traceability model (2026-10-20)

Schema: `deploy/traceability.sql` (idempotent; apply with a privileged MariaDB user because it creates triggers).

- **Origins** (`unit_origins`): a unit has 0..n origins. Each is either a parent unit (`UNIT` + `parent_unit_code`,
  so multiple parents are supported) or a non-unit source: `SPORES`, `PURCHASED`, `STRAIN_LIBRARY`, `OTHER`, `UNKNOWN` (+ note).
  `units.parent_unit_code` is kept as the legacy "primary parent" (= first UNIT origin).
- **Strain inheritance is computed, not copied**: `effectiveStrainCode` = own `strain_code`, else the nearest ancestor's
  via the FIRST parent only (earliest origin row). Setting a strain on a parent therefore immediately applies to all descendants without a strain,
  and nothing has to be cascaded or un-cascaded. Parents with different strains never yield "mixed": the first parent's strain is used.
- **Audit log** (`audit_log`): written by DB triggers on units, unit_locations, unit_origins, events and transfers
  (insert/update/delete, before/after JSON, changed fields, actor, operation id). Append-only: UPDATE/DELETE on
  audit_log are rejected by triggers. The backend sets `@myko_actor` / `@myko_op` per unit of work.
- **Hide** (`units.hidden`, `hidden_at`): visibility only; status and history are untouched. The UI has no hard delete.
- **Operations**: bulk actions share an `operation_id` (events.operation_id, audit_log.operation_id).

API (backend/src/trace.js):
`GET /api/units` (enriched), `PUT /api/units/:code/origins`, `POST /api/units/bulk`, `POST /api/events/bulk` (also `/api/events`),
`POST /api/transfers`, `POST /api/units/bulk-location`, `POST /api/units/bulk-hide`, `GET /api/units/:code/trace`,
`GET /api/units/:code/export?format=json|csv`, `GET /api/audit?unitCode=&operationId=`.
