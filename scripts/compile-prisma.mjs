import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "generated", "prisma", "client.ts");
const outfile = path.join(root, "generated", "prisma", "client.runtime.js");

if (!existsSync(entry)) {
  throw new Error(
    `Prisma client was not generated at ${entry}. Run prisma generate first.`,
  );
}

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
  logLevel: "info",
});
