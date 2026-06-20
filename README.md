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
