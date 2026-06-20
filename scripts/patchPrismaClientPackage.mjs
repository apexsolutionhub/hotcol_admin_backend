import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../generated/prisma/package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

if (pkg.type !== "module") {
  pkg.type = "module";
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log("Patched generated/prisma/package.json with \"type\": \"module\"");
}
