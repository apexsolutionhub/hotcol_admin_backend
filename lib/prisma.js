let prisma = null;
let prismaInitError = null;
let loading = null;

export async function loadPrisma() {
  if (prisma) return prisma;
  if (prismaInitError) throw prismaInitError;
  if (loading) return loading;

  loading = (async () => {
    try {
      const { createPrismaClient } = await import("./prismaClient.js");
      prisma = createPrismaClient();
      if (!prisma?.subscription_pricing_rule?.findMany) {
        throw new Error(
          "Prisma client is out of date — subscription_pricing_rule is missing. Redeploy hotcol-admin-backend after prisma generate.",
        );
      }
      return prisma;
    } catch (error) {
      prismaInitError = error;
      console.error("[HotCol Apex API] Prisma init failed:", error);
      throw error;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

export { prisma };

function firstUsefulFrame(error) {
  const lines = String(error?.stack || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find(
      (line) =>
        line.startsWith("at ") &&
        !line.includes("node:internal") &&
        !line.includes("node:vm"),
    ) || ""
  );
}

export function prismaPublicError(error) {
  const err = error instanceof Error ? error : new Error(String(error ?? ""));
  if (/DATABASE_URL is required/i.test(err.message)) {
    return "DATABASE_URL is not set on the Apex API (Vercel env). Add it on hotcol-admin-backend and redeploy.";
  }
  if (/client\.runtime\.js/i.test(err.message)) {
    return "Apex database client JS bundle is missing. Redeploy hotcol-admin-backend so prisma generate and compile-prisma both run.";
  }
  if (!err.message) return "Apex API database client failed to start.";
  const loc = firstUsefulFrame(err);
  return loc ? `${err.message} (${loc})` : err.message;
}

if (!process.env.VERCEL) {
  await loadPrisma();
}
