/**
 * Fix restored Shambalala ItemRegistrations: they were wrongly given 518–540
 * from the unified HOTEL counter. Item-registration vouchers only went to 0008
 * (batch style: many lines share one voucher). Assign all restored rows voucher 9.
 * Reset HOTEL counter back to 517 (pre-mistake value).
 *
 * Usage:
 *   node scripts/fix-restored-registration-vouchers.js --apply
 */
import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const APPLY = process.argv.includes("--apply");
const HOTEL = "0045905798";
const TARGET_VOUCHER = 9; // next after last item-registration voucher 0008
const COUNTER_RESET_TO = 517; // value before incorrect 518–540 assignment

const prisma = createPrismaClient();

function formatVoucherNumber(seq) {
  const n = Math.max(1, Math.floor(Number(seq) || 0));
  const s = String(n);
  return s.length >= 4 ? s : s.padStart(4, "0");
}

async function main() {
  const rows = await prisma.itemRegistration.findMany({
    where: {
      HotelName: HOTEL,
      supplierName: "Shambalala",
      voucherNumber: { gte: 500 },
    },
    orderBy: { id: "asc" },
    select: { id: true, name: true, voucherNumber: true },
  });

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "DRY-RUN",
        count: rows.length,
        from: rows.map((r) => ({
          id: r.id,
          name: r.name,
          old: formatVoucherNumber(r.voucherNumber),
          new: formatVoucherNumber(TARGET_VOUCHER),
        })),
        counterResetTo: COUNTER_RESET_TO,
      },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log("\nPass --apply to execute.");
    return;
  }

  if (!rows.length) {
    console.log("No high-voucher restored rows found.");
    return;
  }

  const ids = rows.map((r) => r.id);
  const updated = await prisma.itemRegistration.updateMany({
    where: { id: { in: ids } },
    data: { voucherNumber: TARGET_VOUCHER },
  });

  await prisma.hotelVoucherCounter.update({
    where: {
      HotelName_voucherType: {
        HotelName: HOTEL,
        voucherType: "HOTEL",
      },
    },
    data: { lastNumber: COUNTER_RESET_TO },
  });

  const verify = await prisma.itemRegistration.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, voucherNumber: true },
    orderBy: { id: "asc" },
  });
  const counter = await prisma.hotelVoucherCounter.findUnique({
    where: {
      HotelName_voucherType: {
        HotelName: HOTEL,
        voucherType: "HOTEL",
      },
    },
  });

  console.log(
    JSON.stringify(
      {
        updated: updated.count,
        voucherDisplay: formatVoucherNumber(TARGET_VOUCHER),
        counter: counter?.lastNumber,
        sample: verify.slice(0, 5),
      },
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
