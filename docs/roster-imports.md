# Roster Import Format and Operations

Roster import is an organizer-only, preview-first workflow for events with up to 1,000 people. The
source file is parsed during the request and is never persisted. Only normalized preview rows are
stored temporarily; commit and cancel delete those rows immediately, and an expired preview is
scrubbed after 24 hours when the import API next performs cleanup.

## Supported sources

- Excel `.xlsx` workbooks
- UTF-8 `.csv` files
- CSV or TSV copied from Google Sheets, Microsoft Excel, or another table and pasted into the UI

Legacy `.xls`, shared-drive links, workbook passwords/encryption, Google/Microsoft OAuth, macros,
and formula evaluation are not supported. The XLSX parser opens workbooks with formulas visible and
never executes them. A formula in any mapped field is a row validation error.

Limits are applied before commit:

| Boundary                                       |    Limit |
| ---------------------------------------------- | -------: |
| Uploaded/compressed file                       |    5 MiB |
| XLSX uncompressed archive or delimited content |   25 MiB |
| Columns in any row                             |       50 |
| Selected, valid people                         |    1,000 |
| Preview lifetime                               | 24 hours |

An XLSX file with more than one non-empty worksheet requires an explicit worksheet selection. Only
one worksheet is imported per batch.

## Columns and values

The header row can be selected in the mapping step. Column names do not have to match the canonical
names because the organizer maps them explicitly.

| Field      | Required | Rules and default                                             |
| ---------- | -------- | ------------------------------------------------------------- |
| `name`     | yes      | Non-empty display name, at most 100 characters                |
| `email`    | yes      | Valid email; trimmed and lowercased as the event identity key |
| `group`    | no       | Empty by default, at most 100 characters                      |
| `weight`   | no       | Number from `0` through `1`, default `1.0`                    |
| `included` | no       | Boolean, default `true`                                       |

Accepted text for `included` includes `true/false`, `yes/no`, `y/n`, `1/0`, and
`included/excluded`. There is no `required` field. A weight of zero remains a valid included
response: it contributes to the unweighted view but not the weighted score.

Example CSV:

```csv
name,email,group,weight,included
Ada Lovelace,ada@example.edu,Faculty,1,true
Grace Hopper,grace@example.edu,Advisors,0.8,true
Alan Turing,alan@example.edu,Observers,0,false
```

## Duplicate and identity rules

Rows are compared after trimming and email lowercasing.

- Completely identical rows with the same email collapse to one selected row. Later identical
  occurrences remain visible in preview as `identical` duplicates but are deselected.
- Rows with the same email and different name/group/weight/included values are `conflict` rows. Fix
  the values or deselect all but one before commit.
- An email already attached to a verified full account reuses that Member. The organizer can update
  roster metadata and weights, but cannot fill that person's schedule.
- A matched unverified full account is rejected rather than silently assigning its identity.
- A new email creates a temporary Member with an unusable password, an event participant, an
  unsent invitation, dashboard membership, and a default/selected weight.

## UI workflow

The Roster import wizard follows four steps:

1. Choose `.csv`/`.xlsx`, or paste a table.
2. Select the worksheet and header, map columns, and set optional defaults.
3. Review paginated normalized rows; edit or deselect invalid/conflicting rows.
4. Commit as `merge` or `rebuild`.

`merge` adds new people and updates an existing person's name, group, final weight, and included
state. It preserves schedules, account state, and invitation/delivery history.

`rebuild` is destructive within the selected event. The organizer must type the event code. It
revokes active temporary sessions, cancels pending/retrying event email jobs, removes the event's
participants, schedules, weights, invitations, and participant dashboard links, imports the
preview, and returns the event to `draft`. A finalized or archived event must be reopened before
either import mode can be committed.

## HTTP sequence

All endpoints require organizer authentication and a `code` query parameter. Private responses
are not cacheable.

Create from an uploaded file with `multipart/form-data`:

```http
POST /events/roster-imports?code=ABCD1234
Content-Type: multipart/form-data

file=@roster.xlsx
```

Create from pasted data with JSON:

```json
{
  "sourceType": "paste",
  "pastedText": "name\temail\tgroup\nAda\tada@example.edu\tFaculty"
}
```

Configure the preview:

```http
PUT /events/roster-imports/{importId}?code=ABCD1234
```

```json
{
  "worksheet": "Participants",
  "headerRow": 2,
  "columnMapping": {
    "name": "Full Name",
    "email": "Email",
    "group": "Department",
    "weight": "Priority",
    "included": "Included"
  },
  "defaults": { "group": "", "weight": 1, "included": true }
}
```

Mapping values may be an exact header string or a zero-based column index. Each target field must
map to a different source column. `name` and `email` are mandatory.

Read normalized rows:

```http
GET /events/roster-imports/{importId}/rows?code=ABCD1234&page=1&pageSize=50
```

Apply row corrections/deselections with another `PUT`:

```json
{
  "rowUpdates": [
    {
      "id": "row-uuid",
      "email": "corrected@example.edu",
      "selected": true
    }
  ]
}
```

Commit with a new UUID idempotency key:

```http
POST /events/roster-imports/{importId}/commit?code=ABCD1234
```

```json
{
  "mode": "merge",
  "idempotencyKey": "00000000-0000-4000-8000-000000000001"
}
```

For rebuild, use `"mode":"rebuild"` and add `"confirmationCode":"ABCD1234"`. Retrying the same
batch/mode/key returns the same PII-free receipt; reusing a key for a different import is rejected.

Cancel and scrub a preview:

```http
DELETE /events/roster-imports/{importId}?code=ABCD1234
```

## Roster operations after import

- `GET /events/roster?code=` — page/search/filter summaries; page size 50 by default and 100 max.
- `GET /events/roster/{participantId}/schedule?code=` — fetch one full schedule on demand.
- `PATCH /events/roster/{participantId}?code=` — optimistic name/group/weight/included update.
- `PATCH /events/roster/bulk?code=` — update a selected ID list, group, or current filter.

Roster summaries contain identity, group, weight, submitted state, account access, invitation state,
and version. They do not contain availability arrays. Group-level changes write each person's final
weight/included value; a later individual change overrides that value.
