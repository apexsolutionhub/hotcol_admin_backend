import { prisma } from "./prisma.js";
import { findTenantOwner } from "./tenantHelpers.js";
import { allocateVoucherNumber, VOUCHER_TYPES } from "./hotelVoucher.js";

const APEX_SEED_ACTOR = "Apex Excel seed";
const BATCH_TX_OPTS = { timeout: 120_000, maxWait: 20_000 };
const CHUNK_SIZE = 75;

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

function normalizeDept(value, fallback = "STORE") {
  const s = str(value, "department");
  return s || fallback;
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
    receivedByDepartment: normalizeDept(raw.receivedByDepartment, "STORE"),
  };
}

function mapPurchaseRequestLine(raw) {
  return {
    itemName: str(raw.itemName, "Item name", { required: true }),
    quantity: num(raw.quantity, "Quantity"),
    measuredBy: str(raw.measuredBy, "Unit", { required: true }),
    entranceDate: parseDate(raw.entranceDate, "Entrance date") ?? new Date(),
    notes: str(raw.notes, "Notes"),
    estimatedUnitPrice:
      raw.estimatedUnitPrice == null || raw.estimatedUnitPrice === ""
        ? 0
        : num(raw.estimatedUnitPrice, "Estimated unit price"),
    supplierName: str(raw.supplierName, "Supplier name"),
    supplierPhone: str(raw.supplierPhone, "Supplier phone"),
    category: str(raw.category, "Category") || "Others",
    purchaseWithVat: isVatEnabled(raw.purchaseWithVat ?? true),
    requestedByDepartment: normalizeDept(raw.requestedByDepartment, "STORE"),
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
    itemName: str(raw.itemName, "Item name"),
    movementType: str(raw.movementType, "Movement type", { required: true }),
    amount: num(raw.amount, "Quantity"),
    stakeHolderOrReason: str(raw.stakeHolderOrReason, "Stakeholder / reason", {
      required: true,
    }),
    movementDate: parseDate(raw.movementDate, "Movement date"),
    requestedByDepartment: normalizeDept(raw.requestedByDepartment, "STORE"),
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

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const slice = rows.slice(start, start + CHUNK_SIZE);
    try {
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < slice.length; i += 1) {
          const line = mapItemRegistrationLine(slice[i]);
          await tx.itemRegistration.create({
            data: {
              ...line,
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
            },
          });
        }
      }, BATCH_TX_OPTS);
      importedCount += slice.length;
    } catch (e) {
      for (let i = 0; i < slice.length; i += 1) {
        const rowNum = start + i + 1;
        try {
          const line = mapItemRegistrationLine(slice[i]);
          await prisma.itemRegistration.create({
            data: {
              ...line,
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
            },
          });
          importedCount += 1;
        } catch (rowErr) {
          errors.push({
            row: rowNum,
            message: rowErr instanceof Error ? rowErr.message : String(rowErr),
          });
        }
      }
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

async function resolveRegistrationId(tenant, line) {
  if (line.itemRegistrationId != null) {
    const item = await prisma.itemRegistration.findFirst({
      where: { id: line.itemRegistrationId, HotelName: tenant },
    });
    if (!item) throw new Error("Item registration not found for this tenant");
    return item;
  }
  const name = line.itemName;
  if (!name) {
    throw new Error("Item registration ID or item name is required");
  }
  const matches = await prisma.itemRegistration.findMany({
    where: { HotelName: tenant, name },
    orderBy: { id: "desc" },
    take: 2,
  });
  if (!matches.length) {
    throw new Error(`No item registration named "${name}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple registrations named "${name}" — use Item registration ID`,
    );
  }
  return matches[0];
}

function statusLabelForMovement(movementType) {
  if (movementType === "STOCK_OUT") return "Stock Out";
  if (movementType === "WASTAGE") return "Wastage";
  return "Returned to Supplier";
}

async function applyApprovedStockOut(tx, reqRow, item, actorName) {
  const moveAmt = Number(reqRow.amount);
  const onHand = Number(item.amount);
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

  if (newAmount === 0) {
    await tx.itemRegistration.delete({ where: { id: item.id } });
  } else {
    await tx.itemRegistration.update({
      where: { id: item.id },
      data: { amount: newAmount },
    });
  }
}

async function importStockOutRequests(tenant, aliases, rows) {
  const now = new Date();
  const { voucherNumber } = await allocateVoucherNumber(
    prisma,
    tenant,
    VOUCHER_TYPES.STOCK_MOVEMENT,
    aliases,
  );

  let importedCount = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const rowNum = i + 1;
    try {
      const line = mapStockOutLine(rows[i]);
      const item = await resolveRegistrationId(tenant, line);

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

        const freshItem = await tx.itemRegistration.findUnique({
          where: { id: item.id },
        });
        if (!freshItem) throw new Error("Source stock row missing");
        await applyApprovedStockOut(tx, reqRow, freshItem, APEX_SEED_ACTOR);
      }, BATCH_TX_OPTS);

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
