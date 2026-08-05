import express from "express";
import { ApolloServer } from "apollo-server-express";
import cors from "cors";
import "dotenv/config";
import { typeDefs } from "./typeDefs.js";
import { resolvers } from "./resolvers.js";
import { authenticateRequest } from "./lib/apexAuth.js";
import { prisma } from "./lib/prisma.js";

function assertPrismaPricingModel() {
  if (!prisma.subscription_pricing_rule?.findMany) {
    throw new Error(
      "[HotCol Apex API] Prisma client is out of date — subscription_pricing_rule is missing. Run `npm run prisma:generate` in GraphQl-BackEnd.",
    );
  }
}

assertPrismaPricingModel();

const app = express();
app.use(cors({ origin: true, credentials: true }));

const server = new ApolloServer({
  typeDefs,
  resolvers,
  context: ({ req }) => ({
    apex: authenticateRequest(req),
  }),
});

await server.start();
server.applyMiddleware({ app, path: "/graphql", bodyParserConfig: { limit: "2mb" } });

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "OK",
    service: "Apex GraphQL API",
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

/** Required for Vercel serverless — do not call app.listen() there. */
export default app;

if (!process.env.VERCEL) {
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Apex API ready at http://localhost:${port}/graphql`);
    console.log("Prisma: run npm run prisma:generate in this folder after schema changes");
  });
}
