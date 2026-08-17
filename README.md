# Apex GraphQL API

## Prisma

Dashboard models live in `prisma/schema.prisma` (subset of the shared MySQL DB).

```bash
npx prisma generate    # yes — generates local client
# npx prisma db push   # NO — apply DDL from hotcol-user/BackEnd instead
```

Database migrations / new tables: use scripts in **`hotcol-user/BackEnd`** (e.g. `applyApexDashboardTables.js`).

## Run

```bash
npm install
npm run prisma:generate
# Set APEX_ADMIN_PASSWORD in .env (username defaults to apexHotcol)
npm run seed:apex
npm run dev
```

Default: `http://localhost:4001/graphql`

## Vercel (hotcol-admin-backend)

The Apex frontend calls `NEXT_PUBLIC_APEX_API_URL` (default `https://hotcol-admin-backend.vercel.app/graphql`).

On the **backend** Vercel project set:

- `DATABASE_URL` — same MySQL URL as `hotcol-user/BackEnd` (required; missing this crashes GraphQL)
- `JWT_Secret` — same value as local `.env`
- `APEX_ADMIN_USER` / `APEX_ADMIN_PASSWORD` / `APEX_ADMIN_NAME` — for seeding the first Apex login

On the **frontend** Vercel project set:

- `NEXT_PUBLIC_APEX_API_URL=https://hotcol-admin-backend.vercel.app/graphql`

If login toasts “backend is deployed”, open `/health` on the API. `DEGRADED` means the function booted but the database env is missing. `FUNCTION_INVOCATION_FAILED` means check Vercel function logs.
