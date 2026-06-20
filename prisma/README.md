# Apex dashboard Prisma schema

This file defines **only** the models the Apex GraphQL API uses.

- **Generate client:** `npx prisma generate` (from `GraphQl-BackEnd`)
- **Do not run:** `npx prisma db push` or `prisma migrate` here — table changes are applied from `hotcol-user/BackEnd` so both apps stay in sync without overwriting unrelated tables.
