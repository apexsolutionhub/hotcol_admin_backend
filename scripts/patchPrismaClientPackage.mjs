import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../generated/prisma/package.json");

if (!existsSync(pkgPath)) {
  console.log("Skipping Prisma package patch — no package.json (Prisma 7 prisma-client generator with moduleFormat=esm)");
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

if (pkg.type !== "module") {
  pkg.type = "module";
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log("Patched generated/prisma/package.json with \"type\": \"module\"");
}
