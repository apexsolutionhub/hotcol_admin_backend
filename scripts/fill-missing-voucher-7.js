/**
 * Fill missing item-registration voucher 0007 for Shambalala by moving the
 * restored batch from voucher 9 → 7. Leaves existing 0008 untouched.
 *
 * Usage:
 *   node scripts/fill-missing-voucher-7.js --apply
 */
import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const APPLY = process.argv.includes("--apply");
const HOTEL = "0045905798";

const prisma = createPrismaClient();

async function main() {
  const [v7, v9] = await Promise.all([
    prisma.itemRegistration.count({
      where: { HotelName: HOTEL, voucherNumber: 7 },
    }),
    prisma.itemRegistration.findMany({
      where: { HotelName: HOTEL, voucherNumber: 9 },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "DRY-RUN",
        existingVoucher7Count: v7,
        voucher9RowsToMove: v9.length,
        names: v9.map((r) => r.name),
      },
      null,
      2,
    ),
  );

  if (v7 > 0) {
    throw new Error(`Voucher 0007 already has ${v7} registration(s); aborting`);
  }
  if (!v9.length) {
    throw new Error("No voucher 0009 rows to move");
  }

  if (!APPLY) {
    console.log("\nPass --apply to execute.");
    return;
  }

  const result = await prisma.itemRegistration.updateMany({
    where: { HotelName: HOTEL, voucherNumber: 9 },
    data: { voucherNumber: 7 },
  });

  const counts = await prisma.itemRegistration.groupBy({
    by: ["voucherNumber"],
    where: {
      HotelName: HOTEL,
      voucherNumber: { in: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    },
    _count: { _all: true },
    orderBy: { voucherNumber: "asc" },
  });

  console.log(
    JSON.stringify(
      { moved: result.count, registrationVoucherCounts: counts },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
