# Copilot instructions — timesheets-api

Purpose: give an AI coding agent the minimal, concrete knowledge to be productive in this repository.

**Big picture**
- **Service type:** Node.js + TypeScript HTTP API using `fastify` (entry: [src/server.ts](src/server.ts#L1)).
- **Auth & flow:** Azure AD JWTs validated via JWKS in `src/server.ts` (`validateToken`) — tokens are decoded, verified against `TENANT_ID` and `API_AUDIENCE`, and attached to requests as `request.user`.
 - **Auth & flow:** Azure AD JWTs validated via JWKS in `src/server.ts` (`validateToken`) — tokens are decoded, verified against `TENANT_ID` and `CLIENT_ID`, and attached to requests as `request.user`.
- **Database:** Prisma ORM against PostgreSQL. Prisma client is created in `src/prismaClient.ts` and schema lives in `prisma/schema.prisma`.
- **Routing:** Fastify plugins for routes live under `src/routes/` and are registered with prefixes (timesheet routes are registered with `prefix: "/api"`).

**Key files to inspect (quick links)**
- App bootstrap & auth: [src/server.ts](src/server.ts#L1)
- Route examples: [src/routes/timesheet.ts](src/routes/timesheet.ts#L1)
- Prisma client: [src/prismaClient.ts](src/prismaClient.ts#L1)
- Prisma schema: [prisma/schema.prisma](prisma/schema.prisma#L1)
- Prisma config (datasource): [prisma/prisma.config.ts](prisma/prisma.config.ts#L1)
- Fastify type augmentation: [src/types/fastify.d.ts](src/types/fastify.d.ts#L1)

**Developer workflows (exact commands found in `package.json`)**
- Dev (fast reload): `npm run dev` — runs `ts-node-dev` on `src/server.ts`.
- Build: `npm run build` (runs `tsc`).
- Start compiled: `npm run start` (runs `node dist/server.js`).
- Prisma generate: `npm run prisma:generate`. Note: `postinstall` also runs `npx prisma generate`.

Environment variables (used in code)
- `PORT` — server listen port (default 5000)
- `TENANT_ID`, `API_AUDIENCE` — used by JWT verification in `src/server.ts`
 - `TENANT_ID`, `CLIENT_ID` — used by JWT verification in `src/server.ts`
- `CORS_ORIGIN` — allowed origin in the custom CORS register
- `DATABASE_URL` — used by Prisma (`prisma/prisma.config.ts`)
- `ALLOWED_GROUPS` — parsed in server config (comma-separated)

Auth & security patterns (concrete)
- `validateToken` runs on every request via `server.addHook("onRequest", validateToken)` — to add or bypass, search for that hook in `src/server.ts`.
- JWKS are fetched from Azure (`/discovery/v2.0/keys`) and cached in-memory (`publicKeys`). If adding auth-related code, reuse the `fetchPublicKeys()` behavior and `kid` lookup.
- Rate limiting is registered globally via `@fastify/rate-limit` in `src/server.ts` — new routes should rely on the global limiter unless explicitly overridden.

Prisma & schema specifics
- Models: `employee`, `entry`, `project`, `phase`, `task` — date/time fields use `@db.Date` and `@db.Time`; `hours` is `Decimal` with precision `@db.Decimal(5, 2)`. See schema at `prisma/schema.prisma` for types and relations.
- `prisma.employee.upsert(...)` is used in the `/login` route as an example for idempotent user creation.
- Prisma client is exported default from `src/prismaClient.ts` with query logging enabled — use this instance across routes.
- After schema changes run `npm run prisma:generate` and restart the dev server.

Routing & types
- Routes are Fastify plugins (export default async function (fastify, opts) {...}). Register with `server.register(plugin, { prefix: "/api" })`.
- Project augments Fastify types so `request.user` is available; keep `src/types/fastify.d.ts` in sync if you mutate `request.user` shape.

Conventions and gotchas (project-specific)
- Keep authentication in `src/server.ts` as a central `onRequest` hook — many handlers assume `request.user` exists.
- Use `prisma` import from `src/prismaClient.ts` rather than creating new Prisma clients per-file.
- Time/date handling: the schema expects `Date`/`Time` shapes; the commented example in `src/routes/timesheet.ts` shows preferred field names (`date`, `startTime`, `endTime`) and a `timeToMinutes` helper pattern.
- Logging: the server prints env at startup and logs Prisma queries; use these logs for debugging.

When adding features
- Follow the `Fastify plugin -> register in server -> use prisma` pattern.
- Add route-level validation/guards only if they complement the global `validateToken` hook.
- Update `src/types/fastify.d.ts` if you attach new properties to `request`.

Questions / missing info
- CI, tests, and container run commands are not present in repository; if you rely on CI, tell me the target platform and I'll add CI steps.

If anything above is unclear or you want more examples (e.g., how to add a new Prisma migration + route end-to-end), tell me which area to expand.
