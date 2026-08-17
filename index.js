import express from "express";
import { ApolloServer } from "apollo-server-express";
import cors from "cors";
import "dotenv/config";
import { typeDefs } from "./typeDefs.js";
import { resolvers } from "./resolvers.js";
import { authenticateRequest } from "./lib/apexAuth.js";
import { prisma, prismaInitError } from "./lib/prisma.js";

function prismaStartupError() {
  if (prismaInitError) {
    const msg = prismaInitError instanceof Error
      ? prismaInitError.message
      : String(prismaInitError);
    if (/DATABASE_URL is required/i.test(msg)) {
      return "DATABASE_URL is not set on the Apex API (Vercel env). Add it in the hotcol-admin-backend project and redeploy.";
    }
    return `Apex API database client failed to start: ${msg}`;
  }
  if (!prisma) {
    return "Apex API database client is not initialized. Set DATABASE_URL on Vercel and redeploy hotcol-admin-backend.";
  }
  if (!prisma.subscription_pricing_rule?.findMany) {
    return "Prisma client is out of date — subscription_pricing_rule is missing. Redeploy hotcol-admin-backend after prisma generate.";
  }
  return null;
}

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.get("/health", (_req, res) => {
  const dbError = prismaStartupError();
  res.status(dbError ? 503 : 200).json({
    status: dbError ? "DEGRADED" : "OK",
    service: "Apex GraphQL API",
    graphql: "/graphql",
    database: dbError ? "error" : "ok",
    databaseError: dbError,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  const dbError = prismaStartupError();
  res.status(dbError ? 503 : 200).json({
    status: dbError ? "DEGRADED" : "OK",
    service: "Apex GraphQL API",
    graphql: "/graphql",
    health: "/health",
    database: dbError ? "error" : "ok",
  });
});

const dbError = prismaStartupError();
if (dbError) {
  console.error("[HotCol Apex API]", dbError);
  app.use("/graphql", (_req, res) => {
    res.status(503).json({
      errors: [{ message: dbError }],
    });
  });
} else {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => ({
      apex: authenticateRequest(req),
    }),
  });
  await server.start();
  server.applyMiddleware({
    app,
    path: "/graphql",
    bodyParserConfig: { limit: "2mb" },
  });
}

/** Required for Vercel serverless — do not call app.listen() there. */
export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Apex API ready at http://localhost:${port}/graphql`);
    console.log("Prisma: run npm run prisma:generate in this folder after schema changes");
  });
}
