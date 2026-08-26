/**
 * For Shambalala International Hotel remaining supplier "Shambalala" rows:
 *
 * 1) FreshBazaar → recreate as ItemRegistration, then delete FreshBazaar.
 * 2) ItemStatus → add amount onto matching ItemRegistration by name (create if missing),
 *    then delete movements. Names already restored via FreshBazaar are delete-only
 *    (avoid double-count).
 *
 * Usage:
 *   node scripts/restore-shambalala-inventory-from-movements.js         # dry-run
 *   node scripts/restore-shambalala-inventory-from-movements.js --apply
 */
import "dotenv/config";
import { createPrismaClient } from "../lib/prismaClient.js";

const APPLY = process.argv.includes("--apply");
const KEEP_SUPPLIER = "Shambalala";
const HOTEL_LIKE = "%hambalala%";

const prisma = createPrismaClient();

async function resolveHotelTin() {
  const tenants = await prisma.$queryRawUnsafe(
    `SELECT tinNumber, hotelDisplayName FROM tenant_account
     WHERE hotelDisplayName LIKE ? LIMIT 5`,
    HOTEL_LIKE,
  );
  if (!tenants.length) throw new Error("Tenant not found");
  console.log("tenant:", tenants[0]);
  return String(tenants[0].tinNumber);
}

function regKey(name) {
  return String(name || "").trim().toLowerCase();
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const hotel = await resolveHotelTin();
  const where = { HotelName: hotel, supplierName: KEEP_SUPPLIER };

  log("Loading rows…");
  const [movements, bazaar, registrations] = await Promise.all([
    prisma.itemStatus.findMany({ where, orderBy: { id: "asc" } }),
    prisma.freshBazaar.findMany({ where, orderBy: { id: "asc" } }),
    prisma.itemRegistration.findMany({ where, orderBy: { id: "asc" } }),
  ]);

  const bazaarNames = new Set(bazaar.map((b) => regKey(b.name)));

  // Aggregate FreshBazaar qty by name (keep last row as template).
  const bazaarAgg = new Map();
  for (const b of bazaar) {
    const k = regKey(b.name);
    const prev = bazaarAgg.get(k);
    if (!prev) {
      bazaarAgg.set(k, { qty: Number(b.amount || 0), template: b });
    } else {
      prev.qty += Number(b.amount || 0);
      prev.template = b;
    }
  }

  // Aggregate ItemStatus qty by name, excluding bazaar-covered names.
  const moveAgg = new Map();
  let skippedMoveCount = 0;
  for (const m of movements) {
    const k = regKey(m.name);
    if (bazaarNames.has(k)) {
      skippedMoveCount += 1;
      continue;
    }
    const prev = moveAgg.get(k);
    if (!prev) {
      moveAgg.set(k, { qty: Number(m.amount || 0), template: m });
    } else {
      prev.qty += Number(m.amount || 0);
      prev.template = m;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: APPLY ? "APPLY" : "DRY-RUN",
        counts: {
          itemRegistration: registrations.length,
          freshBazaar_rows: bazaar.length,
          freshBazaar_unique_names: bazaarAgg.size,
          itemStatus_rows: movements.length,
          itemStatus_unique_names_to_add: moveAgg.size,
          itemStatus_rows_delete_only: skippedMoveCount,
        },
      },
      null,
      2,
    ),
  );

  if (!APPLY) {
    console.log("\nPass --apply to execute.");
    return;
  }

  // Index existing registrations by name (highest id wins).
  const live = new Map();
  for (const r of registrations) {
    const k = regKey(r.name);
    const prev = live.get(k);
    if (!prev || r.id > prev.id) {
      live.set(k, { id: r.id, amount: Number(r.amount || 0) });
    }
  }

  let created = 0;
  let updated = 0;

  async function ensureAmount(k, qty, template, source) {
    const existing = live.get(k);
    if (existing) {
      const next = existing.amount + qty;
      await prisma.itemRegistration.update({
        where: { id: existing.id },
        data: { amount: next },
      });
      existing.amount = next;
      updated += 1;
      return;
    }

    const isBazaar = source === "bazaar";
    const row = await prisma.itemRegistration.create({
      data: {
        name: template.name,
        imageUrl: template.imageUrl || "",
        category: template.category || "Others",
        amount: qty,
        measuredBy: template.measuredBy || "pcs",
        unitPrice: Number(template.unitPrice || 0),
        registrationDate: isBazaar
          ? template.registrationDate || template.archivedAt || new Date()
          : template.actionDate || new Date(),
        expireDate: isBazaar
          ? template.registrationDate || template.archivedAt || new Date()
          : template.actionDate || new Date(),
        supplierName: template.supplierName || KEEP_SUPPLIER,
        supplierPhone: template.supplierPhone || "",
        Address: template.Address || "",
        purchaseWithVat: Boolean(template.purchaseWithVat),
        supplierTinNumber: template.supplierTinNumber || "",
        paidAmount: Number(template.paidAmount || 0),
        HotelName: hotel,
        approvalStatus: "AUTHORIZED",
        statusBy: isBazaar ? null : template.statusBy || null,
        receivedByDepartment: isBazaar
          ? template.receivedByDepartment || null
          : null,
      },
    });
    if (!row?.id) {
      throw new Error(`create returned null for ${template.name}`);
    }
    live.set(k, { id: row.id, amount: qty });
    created += 1;
  }

  log(`Restoring ${bazaarAgg.size} fresh-bazaar name(s)…`);
  let i = 0;
  for (const [k, { qty, template }] of bazaarAgg) {
    await ensureAmount(k, qty, template, "bazaar");
    i += 1;
    if (i % 5 === 0) log(`  bazaar progress ${i}/${bazaarAgg.size}`);
  }

  if (bazaar.length) {
    log(`Deleting ${bazaar.length} FreshBazaar rows…`);
    await prisma.freshBazaar.deleteMany({
      where: { id: { in: bazaar.map((b) => b.id) } },
    });
  }

  log(`Adding back ${moveAgg.size} stock-movement name(s)…`);
  i = 0;
  for (const [k, { qty, template }] of moveAgg) {
    await ensureAmount(k, qty, template, "movement");
    i += 1;
    if (i % 20 === 0) log(`  movement progress ${i}/${moveAgg.size}`);
  }

  if (movements.length) {
    log(`Deleting ${movements.length} ItemStatus rows…`);
    // delete in chunks to avoid huge IN lists / timeouts
    const ids = movements.map((m) => m.id);
    const chunk = 100;
    for (let start = 0; start < ids.length; start += chunk) {
      const slice = ids.slice(start, start + chunk);
      await prisma.itemStatus.deleteMany({ where: { id: { in: slice } } });
      log(`  deleted movements ${Math.min(start + chunk, ids.length)}/${ids.length}`);
    }
  }

  const result = {
    registrationsCreated: created,
    registrationsUpdated: updated,
    deletedFreshBazaar: bazaar.length,
    deletedMovements: movements.length,
    skippedMovementsCoveredByBazaar: skippedMoveCount,
    after: {
      itemRegistration: await prisma.itemRegistration.count({ where }),
      itemStatus: await prisma.itemStatus.count({ where }),
      freshBazaar: await prisma.freshBazaar.count({ where }),
    },
  };

  log("Done");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
