let prisma = null;
let prismaInitError = null;

try {
  const { createPrismaClient } = await import("./prismaClient.js");
  prisma = createPrismaClient();
} catch (error) {
  prismaInitError = error;
  console.error("[HotCol Apex API] Prisma init failed:", error);
}

export { prisma, prismaInitError };
