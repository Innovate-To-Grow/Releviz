# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install                              # Install all workspace dependencies
npm run dev                              # Start both backend (4000) and frontend (3000)
npm run dev:backend                      # Start backend only
npm run dev:frontend                     # Start frontend only
npm test                                 # Run tests for both workspaces
npm --workspace=backend run test         # Backend tests only
npm --workspace=frontend run test        # Frontend tests only
npm --workspace=frontend run build       # Production build (frontend)
npm --workspace=backend run lint         # Backend lint
npm --workspace=frontend run lint        # Frontend lint
npm run quality-gate                     # Full lint + test + build for both
```

## Architecture

**Monorepo** with two independent services under npm workspaces: `frontend/` (Next.js 15) and `backend/` (Express). Shared config (`.prettierrc`, `.gitignore`, `infra/`, `.github/`) lives at root.

### Backend (`backend/`)

Express 5 server on port 4000. ESM (`"type": "module"`). DynamoDB via `@aws-sdk/*`.

**Route files** in `backend/routes/`:
| Method | Route | File |
|--------|-------|------|
| GET/POST | `/api/events` | `events.js` |
| POST | `/api/events/verify` | `verify.js` |
| GET/POST | `/api/events/participants` | `participants.js` |
| PUT/DELETE | `/api/events/participants/update` | `participantsUpdate.js` |
| GET/PUT | `/api/events/weights` | `weights.js` |
| GET | `/api/health` | `health.js` |
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | `auth.js` |
| GET | `/api/auth/me` | `auth.js` |
| PUT | `/api/auth/settings` | `auth.js` |
| GET | `/api/dashboard/events` | `dashboard.js` |

**Key files:**
- `backend/server.js` — Express app entry point, exports `app` for testing
- `backend/lib/crypto.js` — `generateEventCode()`, `hashPassword()` (scrypt), `verifyPassword()`
- `backend/lib/store/dynamodb.js` — `DynamoSchedulerStore` class wrapping DynamoDB
- `backend/lib/store/types.js` — API-shape mappers (`toApiEvent`, `toApiParticipant`, `toApiWeight`)
- `backend/lib/constants.js` — `DAYS_PER_WEEK`, `DAY_LABELS`

### Frontend (`frontend/`)

Next.js 15 App Router. React 18, Material Web components. No API routes — proxies `/api/*` to backend via `next.config.js` rewrites in dev.

**Key files:**
- `frontend/app/page.js` → home route `/`, renders `CreateEvent`
- `frontend/app/event/page.js` → event route `/event`, renders `EventPage`
- `frontend/components/` — 12 client components (all `"use client"`)
- `frontend/lib/api/config.js` — exports `API_BASE` from `NEXT_PUBLIC_API_BASE_URL` (empty = relative)
- `frontend/lib/api/` — fetch helpers prefixed with `API_BASE`
- `frontend/lib/format.js` — `formatHour()`, `formatMode()`
- `frontend/lib/constants.js` — duplicated 4-line constants file

### Database (DynamoDB)

5 tables: events (PK: `eventCode`), participants (PK: `eventCode`, SK: `participantName`), weights (same keys), users (PK: `userId`, GSI: `email-index`), user_events (PK: `userId`, SK: `eventCode`, GSI: `eventCode-index`).

**Schedule format**: JSON array of floats (0 = busy, 1 = free), length = `(endHour - startHour) * 7`.

### Infrastructure

- `infra/prod/` — Production: single ECS Fargate service (monolith, currently disabled workflows)
- `infra/staging/` — Staging: two ECS services (frontend + backend), ALB path-based routing (`/api/*` → backend, default → frontend), 3 DynamoDB staging tables

## Testing

**Backend** — 61 tests across 6 files. Uses `supertest` + `jest` with ESM (`--experimental-vm-modules`). Mocks use `jest.unstable_mockModule()` + dynamic `await import()`. Test command: `npm --workspace=backend run test`

**Frontend** — 9 tests (ColorUtils). Uses `next/jest` with `moduleNameMapper` for `@/` alias. Test command: `npm --workspace=frontend run test`

## Config Notes

- `frontend/next.config.js`: `output: "standalone"`, security headers, dev rewrites to backend
- `frontend/jsconfig.json`: `@/` path alias
- `backend/package.json`: `"type": "module"` (ESM)
- `.prettierrc`: double quotes, trailing commas, 100 char width
- CI (`.github/workflows/ci.yml`): parallel backend/frontend lint+test+build, then Docker build matrix
- Production workflows (`.disabled` suffix): cutover planned separately
