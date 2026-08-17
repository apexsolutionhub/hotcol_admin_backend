import express from "express";
import cors from "cors";
import "dotenv/config";

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
  res.status(200).json({
    status: "OK",
    service: "Apex GraphQL API",
    graphql: "/graphql",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "OK",
    service: "Apex GraphQL API",
    graphql: "/graphql",
    health: "/health",
  });
});

let graphqlMiddleware = null;
let graphqlLoading = null;

function publicStartError(error) {
  const err = error instanceof Error ? error : new Error(String(error));
  const loc = err.stack?.split("\n")[1]?.trim() || "";
  if (/DATABASE_URL is required/i.test(err.message)) {
    return "DATABASE_URL is not set on the Apex API (Vercel env). Add it on hotcol-admin-backend and redeploy.";
  }
  return loc ? `${err.message} (${loc})` : err.message;
}

async function loadGraphqlMiddleware() {
  if (graphqlMiddleware) return graphqlMiddleware;
  if (graphqlLoading) return graphqlLoading;

  graphqlLoading = (async () => {
    const { loadPrisma, prismaPublicError } = await import("./lib/prisma.js");
    try {
      await loadPrisma();
    } catch (error) {
      throw new Error(prismaPublicError(error));
    }

    const { ApolloServer } = await import("apollo-server-express");
    const { typeDefs } = await import("./typeDefs.js");
    const { resolvers } = await import("./resolvers.js");
    const { authenticateRequest } = await import("./lib/apexAuth.js");

    const server = new ApolloServer({
      typeDefs,
      resolvers,
      context: ({ req }) => ({
        apex: authenticateRequest(req),
      }),
    });
    await server.start();
    // Same shape as applyMiddleware({ app, path: "/graphql" }) on the tenant API.
    graphqlMiddleware = server.getMiddleware({
      path: "/graphql",
      bodyParserConfig: { limit: "2mb" },
    });
    return graphqlMiddleware;
  })().finally(() => {
    graphqlLoading = null;
  });

  return graphqlLoading;
}

app.use((req, res, next) => {
  const path = String(req.path || req.url || "").split("?")[0];
  if (path !== "/graphql" && path !== "/graphql/") {
    return next();
  }
  loadGraphqlMiddleware()
    .then((middleware) => middleware(req, res, next))
    .catch((error) => {
      const message = publicStartError(error);
      console.error("[HotCol Apex API] /graphql:", error);
      if (!res.headersSent) {
        res.status(503).json({ errors: [{ message }] });
      }
    });
});

/** Required for Vercel serverless — do not call app.listen() there. */
export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Apex API ready at http://localhost:${port}/graphql`);
    console.log("Prisma: run npm run prisma:generate in this folder after schema changes");
  });
}
