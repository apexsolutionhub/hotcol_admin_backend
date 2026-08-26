/**
 * Assign voucherNumber to ItemRegistrations created during the Shambalala restore
 * (Fresh Bazaar → registration and any new rows from stock movements) that still
 * have voucherNumber = null. Uses the hotel's unified HOTEL voucher counter.
 *
 * Usage:
 *   node scripts/assign-vouchers-restored-registrations.js         # dry-run
 *   node scripts/assign-vouchers-restored-registrations.js --apply
 */
import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const APPLY = process.argv.includes("--apply");
const HOTEL = "0045905798";
const UNIFIED_VOUCHER_TYPE = "HOTEL";

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
      voucherNumber: null,
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      amount: true,
      receivedByDepartment: true,
    },
  });

  let counter = await prisma.hotelVoucherCounter.findUnique({
    where: {
      HotelName_voucherType: {
        HotelName: HOTEL,
        voucherType: UNIFIED_VOUCHER_TYPE,
      },
    },
  });

  // Seed from max existing docs if counter missing
  if (!counter) {
    const [pr, reg, stat, stock] = await Promise.all([
      prisma.purchaseRequest.aggregate({
        where: { HotelName: HOTEL },
        _max: { voucherNumber: true },
      }),
      prisma.itemRegistration.aggregate({
        where: { HotelName: HOTEL },
        _max: { voucherNumber: true },
      }),
      prisma.itemStatus.aggregate({
        where: { HotelName: HOTEL },
        _max: { voucherNumber: true },
      }),
      prisma.stockOutRequest.aggregate({
        where: { HotelName: HOTEL },
        _max: { voucherNumber: true },
      }),
    ]);
    const seed = Math.max(
      0,
      ...[pr, reg, stat, stock].map((a) =>
        Math.floor(Number(a._max?.voucherNumber) || 0),
      ),
    );
    console.log("No HOTEL counter — would seed at", seed);
    if (APPLY) {
      counter = await prisma.hotelVoucherCounter.create({
        data: {
          HotelName: HOTEL,
          voucherType: UNIFIED_VOUCHER_TYPE,
          lastNumber: seed,
        },
      });
    } else {
      counter = { lastNumber: seed };
    }
  }

  const start = Math.floor(Number(counter.lastNumber) || 0);
  const plan = rows.map((r, i) => ({
    id: r.id,
    name: r.name,
    receivedByDepartment: r.receivedByDepartment,
    voucherNumber: start + i + 1,
    voucherDisplay: formatVoucherNumber(start + i + 1),
  }));

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "DRY-RUN",
        rowsNeedingVoucher: rows.length,
        counterBefore: start,
        counterAfter: start + rows.length,
        plan,
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
    console.log("Nothing to do.");
    return;
  }

  for (const p of plan) {
    await prisma.itemRegistration.update({
      where: { id: p.id },
      data: { voucherNumber: p.voucherNumber },
    });
    console.log(`  ${p.name} → ${p.voucherDisplay}`);
  }

  await prisma.hotelVoucherCounter.update({
    where: {
      HotelName_voucherType: {
        HotelName: HOTEL,
        voucherType: UNIFIED_VOUCHER_TYPE,
      },
    },
    data: { lastNumber: start + rows.length },
  });

  const stillNull = await prisma.itemRegistration.count({
    where: {
      HotelName: HOTEL,
      supplierName: "Shambalala",
      voucherNumber: null,
    },
  });
  const updatedCounter = await prisma.hotelVoucherCounter.findUnique({
    where: {
      HotelName_voucherType: {
        HotelName: HOTEL,
        voucherType: UNIFIED_VOUCHER_TYPE,
      },
    },
  });

  console.log(
    JSON.stringify(
      {
        assigned: plan.length,
        stillNull,
        counter: updatedCounter?.lastNumber,
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
