import bcrypt from "bcryptjs";
import "dotenv/config";
import { prisma } from "../lib/prisma.js";

const DEFAULT_USER = "apexHotcol";
const DEFAULT_DISPLAY = "Apex Admin";

async function main() {
  const userName = (process.env.APEX_ADMIN_USER || DEFAULT_USER).trim();
  const password = process.env.APEX_ADMIN_PASSWORD;
  const displayName = (process.env.APEX_ADMIN_NAME || DEFAULT_DISPLAY).trim();

  if (!password || String(password).length < 6) {
    throw new Error(
      "Set APEX_ADMIN_PASSWORD in .env (min 6 characters). Username defaults to apexHotcol.",
    );
  }

  const hash = await bcrypt.hash(password, 12);
  const member = await prisma.apex_team_member.upsert({
    where: { UserName: userName },
    create: {
      UserName: userName,
      Password: hash,
      displayName,
      role: "admin",
      isActive: true,
    },
    update: {
      Password: hash,
      displayName,
      role: "admin",
      isActive: true,
    },
  });

  console.log(`Apex admin ready: ${member.UserName} (id ${member.id})`);
  console.log("Sign in at /login with that username and APEX_ADMIN_PASSWORD.");
  console.log("Change the password after first login.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
