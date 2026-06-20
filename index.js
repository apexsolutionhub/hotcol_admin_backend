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
    console.error(
      "\n[HotCol Apex API] Prisma client is out of date — subscription_pricing_rule is missing.\n" +
        "  cd GraphQl-BackEnd\n" +
        "  npm run prisma:generate\n" +
        "  Restart: npm run dev\n",
    );
    process.exit(1);
  }
}

async function startServer() {
  assertPrismaPricingModel();
  const app = express();
  app.use(cors());

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: ({ req }) => ({
      apex: authenticateRequest(req),
    }),
  });

  await server.start();
  server.applyMiddleware({ app, path: "/graphql" });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "OK",
      service: "Apex GraphQL API",
      timestamp: new Date().toISOString(),
    });
  });

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Apex API ready at http://localhost:${port}/graphql`);
    console.log("Prisma: run npm run prisma:generate in this folder after schema changes");
  });
}

startServer().catch((err) => {
  console.error("Server startup error:", err);
  process.exit(1);
});
