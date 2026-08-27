import { prisma } from "./prisma.js";
import { findTenantOwner } from "./tenantHelpers.js";
import { allocateVoucherNumber, VOUCHER_TYPES } from "./hotelVoucher.js";

const APEX_SEED_ACTOR = "Apex Excel seed";
const BATCH_TX_OPTS = { timeout: 120_000, maxWait: 20_000 };

const VALID_KINDS = new Set([
  "item_registration",
  "purchase_request",
  "stockout_request",
]);

function isVatEnabled(flag) {
  if (flag === true) return true;
  if (typeof flag === "string") {
    const v = flag.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  if (typeof flag === "number") return flag === 1;
  return false;
}

function parseDate(value, label) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return d;
}

function parseRequiredDate(value, label) {
  const d = parseDate(value, label);
  if (!d) throw new Error(`${label} is required`);
  return d;
}

function num(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function str(value, label, { required = false } = {}) {
  const s = value == null ? "" : String(value).trim();
  if (required && !s) throw new Error(`${label} is required`);
  return s;
}

function normalizeDept(value, { required = false, fallback = "" } = {}) {
  const s = str(value, "department", { required });
  return s || fallback;
}

function sameDay(a, b) {
  if (!a || !b) return a == null && b == null;
  const da = a instanceof Date ? a : new Date(a);
  const db = b instanceof Date ? b : new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

function nearlyEqual(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

async function resolveTenantScope(tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) throw new Error("TIN is required");
  const owner = await findTenantOwner(tin);
  if (!owner) throw new Error("Tenant not found");
  const aliases = [tin];
  if (owner.HotelName && String(owner.HotelName).trim() !== tin) {
    aliases.push(String(owner.HotelName).trim());
  }
  return { tin, owner, aliases };
}

function mapItemRegistrationLine(raw) {
  return {
    name: str(raw.name, "Item name", { required: true }),
    imageUrl: str(raw.imageUrl, "Image URL") || "",
    category: str(raw.category, "Category", { required: true }),
    amount: num(raw.amount, "Quantity"),
    measuredBy: str(raw.measuredBy, "Unit", { required: true }),
    unitPrice: num(raw.unitPrice, "Unit price"),
    registrationDate: parseRequiredDate(raw.registrationDate, "Registration date"),
    expireDate: parseRequiredDate(raw.expireDate, "Expire date"),
    supplierName: str(raw.supplierName, "Supplier name", { required: true }),
    supplierPhone: str(raw.supplierPhone, "Supplier phone"),
    Address: str(raw.Address, "Supplier address", { required: true }),
    purchaseWithVat: isVatEnabled(raw.purchaseWithVat),
    supplierTinNumber: str(raw.supplierTinNumber, "Supplier TIN"),
    paidAmount: num(raw.paidAmount, "Paid amount"),
    receivedByDepartment: normalizeDept(raw.receivedByDepartment, {
      fallback: "STORE",
    }),
  };
}

function mapPurchaseRequestLine(raw) {
  return {
    itemName: str(raw.itemName, "Item name", { required: true }),
    quantity: num(raw.quantity, "Quantity"),
    measuredBy: str(raw.measuredBy, "Unit", { required: true }),
    entranceDate: parseRequiredDate(raw.entranceDate, "Entrance date"),
    notes: str(raw.notes, "Notes"),
    estimatedUnitPrice: num(raw.estimatedUnitPrice, "Estimated unit price"),
    supplierName: str(raw.supplierName, "Supplier name", { required: true }),
    supplierPhone: str(raw.supplierPhone, "Supplier phone", { required: true }),
    category: str(raw.category, "Category", { required: true }),
    purchaseWithVat: isVatEnabled(raw.purchaseWithVat),
    requestedByDepartment: normalizeDept(raw.requestedByDepartment, {
      required: true,
    }),
  };
}

function mapStockOutLine(raw) {
  const regIdRaw = raw.itemRegistrationId;
  const regId =
    regIdRaw == null || regIdRaw === ""
      ? null
      : Math.floor(Number(regIdRaw));
  if (regId != null && !(regId > 0)) {
    throw new Error("Item registration ID is invalid");
  }
  return {
    itemRegistrationId: regId,
    itemName: str(raw.itemName, "Item name", { required: true }),
    movementType: str(raw.movementType, "Movement type", { required: true }),
    amount: num(raw.amount, "Quantity"),
    stakeHolderOrReason: str(raw.stakeHolderOrReason, "Stakeholder / reason", {
      required: true,
    }),
    movementDate: parseRequiredDate(raw.movementDate, "Movement date"),
    requestedByDepartment: normalizeDept(raw.requestedByDepartment, {
      required: true,
    }),
  };
}

/** Reject when every required field already matches an existing registration. */
async function findDuplicateItemRegistration(tenant, line) {
  const candidates = await prisma.itemRegistration.findMany({
    where: {
      HotelName: tenant,
      name: line.name,
      category: line.category,
      measuredBy: line.measuredBy,
      supplierName: line.supplierName,
      Address: line.Address,
    },
  });
  return candidates.find(
    (row) =>
      nearlyEqual(row.amount, line.amount) &&
      nearlyEqual(row.unitPrice, line.unitPrice) &&
      nearlyEqual(row.paidAmount, line.paidAmount) &&
      sameDay(row.registrationDate, line.registrationDate) &&
      sameDay(row.expireDate, line.expireDate),
  );
}

async function findDuplicatePurchaseRequest(tenant, line) {
  const candidates = await prisma.purchaseRequest.findMany({
    where: {
      HotelName: tenant,
      itemName: line.itemName,
      measuredBy: line.measuredBy,
      supplierName: line.supplierName,
      supplierPhone: line.supplierPhone,
      category: line.category,
      requestedByDepartment: line.requestedByDepartment,
    },
  });
  return candidates.find(
    (row) =>
      nearlyEqual(row.quantity, line.quantity) &&
      nearlyEqual(row.estimatedUnitPrice, line.estimatedUnitPrice) &&
      Boolean(row.purchaseWithVat) === Boolean(line.purchaseWithVat) &&
      sameDay(row.entranceDate, line.entranceDate),
  );
}

function itemRegistrationSeedData(mapped, tenant, voucherNumber, now) {
  return {
    ...mapped,
    HotelName: tenant,
    voucherNumber,
    approvalStatus: "AUTHORIZED",
    statusBy: APEX_SEED_ACTOR,
    managerActorName: APEX_SEED_ACTOR,
    managerAuthorizedAt: now,
    financeActorName: APEX_SEED_ACTOR,
    financeApprovedAt: now,
    ccActorName: APEX_SEED_ACTOR,
    ccCheckedAt: now,
  };
}

async function importItemRegistrations(tenant, aliases, rows) {
  const now = new Date();
  const { voucherNumber } = await allocateVoucherNumber(
    prisma,
    tenant,
    VOUCHER_TYPES.ITEM_REGISTRATION,
    aliases,
  );

  let importedCount = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const rowNum = i + 1;
    try {
      const line = mapItemRegistrationLine(rows[i]);
      const dup = await findDuplicateItemRegistration(tenant, line);
      if (dup) {
        throw new Error(
          `Already registered (id ${dup.id}) with the same required fields`,
        );
      }
      await prisma.itemRegistration.create({
        data: itemRegistrationSeedData(line, tenant, voucherNumber, now),
      });
      importedCount += 1;
    } catch (e) {
      errors.push({
        row: rowNum,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { importedCount, errors, voucherNumber };
}

async function importPurchaseRequests(tenant, aliases, rows) {
  const now = new Date();
  const { voucherNumber } = await allocateVoucherNumber(
    prisma,
    tenant,
    VOUCHER_TYPES.PURCHASE_REQUEST,
    aliases,
  );

  let importedCount = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const rowNum = i + 1;
    try {
      const line = mapPurchaseRequestLine(rows[i]);
      const dup = await findDuplicatePurchaseRequest(tenant, line);
      if (dup) {
        throw new Error(
          `Purchase request already exists (id ${dup.id}) with the same required fields`,
        );
      }
      await prisma.purchaseRequest.create({
        data: {
          HotelName: tenant,
          itemName: line.itemName,
          quantity: line.quantity,
          measuredBy: line.measuredBy,
          entranceDate: line.entranceDate,
          notes: line.notes,
          estimatedUnitPrice: line.estimatedUnitPrice,
          supplierName: line.supplierName,
          supplierPhone: line.supplierPhone,
          category: line.category,
          purchaseWithVat: line.purchaseWithVat,
          status: "AUTHORIZED",
          storeUserName: APEX_SEED_ACTOR,
          voucherNumber,
          requestedByDepartment: line.requestedByDepartment,
          ccActorName: APEX_SEED_ACTOR,
          ccApprovedAt: now,
          financeActorName: APEX_SEED_ACTOR,
          financeApprovedAt: now,
          managerActorName: APEX_SEED_ACTOR,
          managerAuthorizedAt: now,
        },
      });
      importedCount += 1;
    } catch (e) {
      errors.push({
        row: rowNum,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { importedCount, errors, voucherNumber };
}

/**
 * Resolve an existing registration from a preloaded name → rows map.
 * Same name may appear more than once — prefer enough on-hand qty (newest first).
 * Mutates remainingQtyById so later Excel rows with the same name can still import.
 */
function pickRegistrationFromCache(line, byId, byName, remainingQtyById) {
  if (line.itemRegistrationId != null) {
    const item = byId.get(line.itemRegistrationId);
    if (!item) throw new Error("Item registration not found for this tenant");
    return item;
  }

  const matches = byName.get(line.itemName) || [];
  if (!matches.length) return null;

  const withStock = matches.find((m) => {
    const left = remainingQtyById.has(m.id)
      ? remainingQtyById.get(m.id)
      : Number(m.amount);
    return left >= Number(line.amount);
  });
  return withStock || matches[0];
}

function statusLabelForMovement(movementType) {
  if (movementType === "STOCK_OUT") return "Stock Out";
  if (movementType === "WASTAGE") return "Wastage";
  return "Returned to Supplier";
}

async function applyApprovedStockOut(tx, reqRow, item, actorName, remainingQtyById) {
  const moveAmt = Number(reqRow.amount);
  const onHand = remainingQtyById.has(item.id)
    ? Number(remainingQtyById.get(item.id))
    : Number(item.amount);
  if (!(moveAmt > 0)) throw new Error("Quantity must be positive");
  if (moveAmt > onHand) {
    throw new Error("Requested quantity exceeds stock on hand");
  }

  const newAmount = onHand - moveAmt;
  const decidedNow = new Date();
  const actionDate =
    reqRow.movementDate != null ? new Date(reqRow.movementDate) : decidedNow;

  await tx.itemStatus.create({
    data: {
      name: item.name,
      imageUrl: item.imageUrl,
      category: item.category,
      amount: moveAmt,
      measuredBy: item.measuredBy,
      unitPrice: item.unitPrice,
      actionDate,
      supplierName: item.supplierName,
      supplierPhone: item.supplierPhone,
      Address: item.Address,
      purchaseWithVat: Boolean(item.purchaseWithVat),
      supplierTinNumber: String(item.supplierTinNumber ?? "").trim(),
      paidAmount: item.paidAmount,
      status: statusLabelForMovement(reqRow.movementType),
      statusBy: actorName,
      HotelName: reqRow.HotelName,
      voucherNumber: reqRow.voucherNumber ?? null,
      stockOutRequestId: reqRow.id,
    },
  });

  remainingQtyById.set(item.id, newAmount);

  if (newAmount === 0) {
    await tx.itemRegistration.delete({ where: { id: item.id } });
  } else {
    await tx.itemRegistration.update({
      where: { id: item.id },
      data: { amount: newAmount },
    });
  }
}

/**
 * Seed a Fresh Bazaar archive for a stock movement whose item is not in
 * registration and whose department is not STORE.
 */
async function seedFreshBazaarMovement(tenant, line, voucherNumber, now) {
  const dept = String(line.requestedByDepartment || "").trim().toUpperCase();
  const receivedBy =
    dept === "BAR" ? "BAR" : dept === "KITCHEN" ? "KITCHEN" : dept || "KITCHEN";

  await prisma.$transaction(async (tx) => {
    const reg = await tx.itemRegistration.create({
      data: {
        name: line.itemName,
        imageUrl: "",
        category: "Others",
        amount: line.amount,
        measuredBy: "Piece",
        unitPrice: 0,
        registrationDate: line.movementDate || now,
        expireDate: line.movementDate || now,
        supplierName: APEX_SEED_ACTOR,
        supplierPhone: "",
        Address: "",
        purchaseWithVat: false,
        supplierTinNumber: "",
        paidAmount: 0,
        HotelName: tenant,
        voucherNumber,
        approvalStatus: "AUTHORIZED",
        statusBy: APEX_SEED_ACTOR,
        receivedByDepartment: receivedBy,
        managerActorName: APEX_SEED_ACTOR,
        managerAuthorizedAt: now,
        financeActorName: APEX_SEED_ACTOR,
        financeApprovedAt: now,
        ccActorName: APEX_SEED_ACTOR,
        ccCheckedAt: now,
      },
    });

    const reqRow = await tx.stockOutRequest.create({
      data: {
        HotelName: tenant,
        itemRegistrationId: reg.id,
        itemNameSnapshot: line.itemName,
        movementType: line.movementType,
        amount: line.amount,
        stakeHolderOrReason: line.stakeHolderOrReason,
        movementDate: line.movementDate,
        status: "APPROVED",
        voucherNumber,
        requestedByUserName: APEX_SEED_ACTOR,
        requestedByDepartment: line.requestedByDepartment,
        ccActorName: APEX_SEED_ACTOR,
        ccCheckedAt: now,
        financeActorName: APEX_SEED_ACTOR,
        financeApprovedAt: now,
        managerActorName: APEX_SEED_ACTOR,
        managerAuthorizedAt: now,
        decidedAt: now,
      },
    });

    await tx.itemStatus.create({
      data: {
        name: line.itemName,
        imageUrl: "",
        category: "Others",
        amount: line.amount,
        measuredBy: "Piece",
        unitPrice: 0,
        actionDate: line.movementDate || now,
        supplierName: APEX_SEED_ACTOR,
        supplierPhone: "",
        Address: "",
        purchaseWithVat: false,
        supplierTinNumber: "",
        paidAmount: 0,
        status: statusLabelForMovement(line.movementType),
        statusBy: APEX_SEED_ACTOR,
        HotelName: tenant,
        voucherNumber,
        stockOutRequestId: reqRow.id,
      },
    });

    await tx.freshBazaar.create({
      data: {
        HotelName: tenant,
        itemRegistrationId: reg.id,
        stockOutRequestId: reqRow.id,
        name: line.itemName,
        imageUrl: "",
        category: "Others",
        amount: line.amount,
        measuredBy: "Piece",
        unitPrice: 0,
        purchaseWithVat: false,
        paidAmount: 0,
        supplierName: APEX_SEED_ACTOR,
        supplierPhone: "",
        Address: "",
        supplierTinNumber: "",
        receivedByDepartment: receivedBy,
        registrationDate: line.movementDate || now,
        archivedAt: now,
      },
    });

    await tx.itemRegistration.delete({ where: { id: reg.id } });
  }, BATCH_TX_OPTS);
}

async function importStockOutRequests(tenant, aliases, rows) {
  const now = new Date();
  const { voucherNumber } = await allocateVoucherNumber(
    prisma,
    tenant,
    VOUCHER_TYPES.STOCK_MOVEMENT,
    aliases,
  );

  // Parse all lines first so we can preload registrations in one query.
  const parsed = [];
  const errors = [];
  for (let i = 0; i < rows.length; i += 1) {
    try {
      parsed.push({ rowNum: i + 1, line: mapStockOutLine(rows[i]) });
    } catch (e) {
      errors.push({
        row: i + 1,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const names = [
    ...new Set(
      parsed
        .map((p) => p.line.itemName)
        .filter(Boolean),
    ),
  ];
  const ids = [
    ...new Set(
      parsed
        .map((p) => p.line.itemRegistrationId)
        .filter((id) => id != null && id > 0),
    ),
  ];

  const regs =
    names.length || ids.length
      ? await prisma.itemRegistration.findMany({
          where: {
            HotelName: tenant,
            OR: [
              ...(names.length ? [{ name: { in: names } }] : []),
              ...(ids.length ? [{ id: { in: ids } }] : []),
            ],
          },
          orderBy: { id: "desc" },
        })
      : [];

  const byId = new Map(regs.map((r) => [r.id, r]));
  const byName = new Map();
  for (const r of regs) {
    const list = byName.get(r.name) || [];
    list.push(r);
    byName.set(r.name, list);
  }
  const remainingQtyById = new Map(regs.map((r) => [r.id, Number(r.amount)]));

  // Preload recent stock-outs for duplicate checks (required-field match).
  const regIds = regs.map((r) => r.id);
  const existingMoves =
    regIds.length > 0
      ? await prisma.stockOutRequest.findMany({
          where: { HotelName: tenant, itemRegistrationId: { in: regIds } },
          select: {
            id: true,
            itemRegistrationId: true,
            movementType: true,
            amount: true,
            stakeHolderOrReason: true,
            movementDate: true,
            requestedByDepartment: true,
          },
        })
      : [];

  function hasDuplicateStockOut(line, itemRegistrationId) {
    return existingMoves.some(
      (row) =>
        row.itemRegistrationId === itemRegistrationId &&
        row.movementType === line.movementType &&
        row.stakeHolderOrReason === line.stakeHolderOrReason &&
        row.requestedByDepartment === line.requestedByDepartment &&
        nearlyEqual(row.amount, line.amount) &&
        sameDay(row.movementDate, line.movementDate),
    );
  }

  let importedCount = 0;

  for (const { rowNum, line } of parsed) {
    try {
      if (!(Number(line.amount) > 0)) {
        throw new Error("Quantity must be positive");
      }

      const item = pickRegistrationFromCache(
        line,
        byId,
        byName,
        remainingQtyById,
      );

      if (item) {
        if (hasDuplicateStockOut(line, item.id)) {
          throw new Error(
            `Stock movement already exists with the same required fields`,
          );
        }

        await prisma.$transaction(async (tx) => {
          const reqRow = await tx.stockOutRequest.create({
            data: {
              HotelName: tenant,
              itemRegistrationId: item.id,
              itemNameSnapshot: String(item.name).trim(),
              movementType: line.movementType,
              amount: line.amount,
              stakeHolderOrReason: line.stakeHolderOrReason,
              movementDate: line.movementDate,
              status: "APPROVED",
              voucherNumber,
              requestedByUserName: APEX_SEED_ACTOR,
              requestedByDepartment: line.requestedByDepartment,
              ccActorName: APEX_SEED_ACTOR,
              ccCheckedAt: now,
              financeActorName: APEX_SEED_ACTOR,
              financeApprovedAt: now,
              managerActorName: APEX_SEED_ACTOR,
              managerAuthorizedAt: now,
              decidedAt: now,
            },
          });

          await applyApprovedStockOut(
            tx,
            reqRow,
            item,
            APEX_SEED_ACTOR,
            remainingQtyById,
          );

          existingMoves.push({
            id: reqRow.id,
            itemRegistrationId: item.id,
            movementType: line.movementType,
            amount: line.amount,
            stakeHolderOrReason: line.stakeHolderOrReason,
            movementDate: line.movementDate,
            requestedByDepartment: line.requestedByDepartment,
          });
        }, BATCH_TX_OPTS);

        importedCount += 1;
        continue;
      }

      const dept = String(line.requestedByDepartment || "")
        .trim()
        .toUpperCase();
      if (dept === "STORE") {
        throw new Error(
          `Item "${line.itemName}" is not in item registration — STORE movements require an existing registration`,
        );
      }

      await seedFreshBazaarMovement(tenant, line, voucherNumber, now);
      importedCount += 1;
    } catch (e) {
      errors.push({
        row: rowNum,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { importedCount, errors, voucherNumber };
}

/**
 * Apex-admin bulk Excel seed import.
 * @param {{ tinNumber: string, kind: string, rows: unknown[] }} input
 */
export async function apexImportTenantExcel(input) {
  const tinNumber = String(input.tinNumber || "").trim();
  const kind = String(input.kind || "").trim();
  const rows = Array.isArray(input.rows) ? input.rows : [];

  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Unknown import kind: ${kind}`);
  }
  if (!rows.length) {
    throw new Error("No rows to import");
  }

  const { tin, aliases } = await resolveTenantScope(tinNumber);
  let result;

  if (kind === "item_registration") {
    result = await importItemRegistrations(tin, aliases, rows);
  } else if (kind === "purchase_request") {
    result = await importPurchaseRequests(tin, aliases, rows);
  } else {
    result = await importStockOutRequests(tin, aliases, rows);
  }

  const skippedCount = rows.length - result.importedCount;
  const message =
    result.errors.length === 0
      ? `Imported ${result.importedCount} row(s) for ${tin} (voucher ${result.voucherNumber}).`
      : `Imported ${result.importedCount} of ${rows.length} row(s); ${result.errors.length} failed.`;

  return {
    importedCount: result.importedCount,
    skippedCount,
    message,
    errors: result.errors,
  };
}
