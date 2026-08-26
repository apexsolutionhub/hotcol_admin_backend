/**
 * One-off: for Shambalala International Hotel, delete ItemRegistration,
 * ItemStatus (stock movement), and FreshBazaar rows whose supplierName
 * is not exactly "Shambalala".
 *
 * Usage:
 *   node scripts/cleanup-shambalala-non-supplier.js          # dry-run
 *   node scripts/cleanup-shambalala-non-supplier.js --apply  # delete
 */
import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const APPLY = process.argv.includes("--apply");
const KEEP_SUPPLIER = "Shambalala";

const prisma = createPrismaClient();

function notKeepSupplier() {
  return {
    NOT: {
      supplierName: KEEP_SUPPLIER,
    },
  };
}

async function resolveHotelName() {
  const like = "%hambalala%";
  const found = new Set();

  // Inventory tables key by HotelName = tenant TIN (not display name).
  const tenants = await prisma.$queryRawUnsafe(
    `SELECT tinNumber, hotelDisplayName FROM tenant_account
     WHERE hotelDisplayName LIKE ? LIMIT 20`,
    like,
  );
  console.log("tenant_account matches:", tenants);
  for (const t of tenants) {
    if (t.tinNumber) found.add(String(t.tinNumber));
  }

  if (!found.size) {
    throw new Error(
      'No tenant_account row with hotelDisplayName matching "hambalala"',
    );
  }
  return [...found];
}

async function summarize(hotelName) {
  const whereHotel = { HotelName: hotelName };
  const whereDelete = { ...whereHotel, ...notKeepSupplier() };
  const whereKeep = { ...whereHotel, supplierName: KEEP_SUPPLIER };

  const [
    irDelete,
    irKeep,
    isDelete,
    isKeep,
    fbDelete,
    fbKeep,
    irSuppliers,
    isSuppliers,
    fbSuppliers,
  ] = await Promise.all([
    prisma.itemRegistration.count({ where: whereDelete }),
    prisma.itemRegistration.count({ where: whereKeep }),
    prisma.itemStatus.count({ where: whereDelete }),
    prisma.itemStatus.count({ where: whereKeep }),
    prisma.freshBazaar.count({ where: whereDelete }),
    prisma.freshBazaar.count({ where: whereKeep }),
    prisma.itemRegistration.groupBy({
      by: ["supplierName"],
      where: whereHotel,
      _count: { _all: true },
      orderBy: { _count: { supplierName: "desc" } },
    }),
    prisma.itemStatus.groupBy({
      by: ["supplierName"],
      where: whereHotel,
      _count: { _all: true },
      orderBy: { _count: { supplierName: "desc" } },
    }),
    prisma.freshBazaar.groupBy({
      by: ["supplierName"],
      where: whereHotel,
      _count: { _all: true },
      orderBy: { _count: { supplierName: "desc" } },
    }),
  ]);

  return {
    hotelName,
    counts: {
      itemRegistration: { delete: irDelete, keep: irKeep },
      itemStatus_stockMovement: { delete: isDelete, keep: isKeep },
      freshBazaar: { delete: fbDelete, keep: fbKeep },
    },
    suppliers: {
      itemRegistration: irSuppliers,
      itemStatus: isSuppliers,
      freshBazaar: fbSuppliers,
    },
  };
}

async function applyDelete(hotelName) {
  const whereDelete = { HotelName: hotelName, ...notKeepSupplier() };

  // FreshBazaar first (archives referencing registrations), then stock movement, then registrations.
  // Also remove stock-out requests that point at registrations we are about to delete.
  const doomedRegs = await prisma.itemRegistration.findMany({
    where: whereDelete,
    select: { id: true },
  });
  const doomedIds = doomedRegs.map((r) => r.id);

  return prisma.$transaction(async (tx) => {
    const stockOut =
      doomedIds.length === 0
        ? { count: 0 }
        : await tx.stockOutRequest.deleteMany({
            where: {
              HotelName: hotelName,
              itemRegistrationId: { in: doomedIds },
            },
          });

    const fresh = await tx.freshBazaar.deleteMany({ where: whereDelete });
    const status = await tx.itemStatus.deleteMany({ where: whereDelete });
    const regs = await tx.itemRegistration.deleteMany({ where: whereDelete });

    return {
      stockOutRequest: stockOut.count,
      freshBazaar: fresh.count,
      itemStatus: status.count,
      itemRegistration: regs.count,
    };
  });
}

async function main() {
  const hotels = await resolveHotelName();
  if (!hotels.length) {
    throw new Error('Could not find hotel matching "shambalala"');
  }

  console.log("Matched HotelName(s):", hotels);
  console.log(
    APPLY
      ? "MODE: APPLY (deleting)"
      : "MODE: DRY-RUN (pass --apply to delete)",
  );
  console.log(`Keep supplierName === "${KEEP_SUPPLIER}" (exact match)`);

  for (const hotelName of hotels) {
    const summary = await summarize(hotelName);
    console.log("\n=== Summary ===");
    console.log(JSON.stringify(summary, null, 2));

    if (!APPLY) continue;

    const deleted = await applyDelete(hotelName);
    console.log("\n=== Deleted ===");
    console.log(JSON.stringify(deleted, null, 2));

    const after = await summarize(hotelName);
    console.log("\n=== After ===");
    console.log(JSON.stringify(after.counts, null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
