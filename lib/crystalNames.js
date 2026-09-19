/**
 * Crystal name helpers for Apex CRUD (shared crystal_name + proposals with hotcol-user).
 */

export function crystalLabel(row) {
  const a = String(row.amharic || "").trim();
  const r = String(row.romanized || "").trim();
  const e = String(row.english || "").trim();
  if (a && r && e) return `${a}|${r}|${e}`;
  const raw = String(row.rawText || "").trim();
  if (raw) return raw;
  return [a, r, e].filter(Boolean).join("|");
}

export function trimCrystalField(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label} is required`);
  if (s.length > 255) throw new Error(`${label} must be at most 255 characters`);
  return s;
}

function resolveApprovalTriple(proposal, overrides = {}) {
  const amharic = trimCrystalField(
    overrides.amharic != null && String(overrides.amharic).trim() !== ""
      ? overrides.amharic
      : proposal.amharic,
    "Amharic",
  );
  const romanized = trimCrystalField(
    overrides.romanized != null && String(overrides.romanized).trim() !== ""
      ? overrides.romanized
      : proposal.romanized,
    "Romanized",
  );
  const english = trimCrystalField(
    overrides.english != null && String(overrides.english).trim() !== ""
      ? overrides.english
      : proposal.english,
    "English",
  );
  return { amharic, romanized, english };
}

export function mapCrystalNameRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    amharic: row.amharic,
    romanized: row.romanized,
    english: row.english,
    crystalLabel: crystalLabel(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapCrystalProposalRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    rawText: row.rawText,
    amharic: row.amharic,
    romanized: row.romanized,
    english: row.english,
    crystalLabel: crystalLabel(row),
    status: row.status,
    source: row.source,
    HotelName: row.HotelName ?? null,
    tinNumber: row.tinNumber ?? null,
    proposedBy: row.proposedBy ?? null,
    mergedIntoId: row.mergedIntoId ?? null,
    reviewNote: row.reviewNote ?? null,
    reviewedBy: row.reviewedBy ?? null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listCrystalNames(prisma, { search, take, skip } = {}) {
  const limit = Math.min(Math.max(Number(take) || 500, 1), 2000);
  const offset = Math.max(Number(skip) || 0, 0);
  const q = String(search || "").trim();

  const where = q
    ? {
        OR: [
          { amharic: { contains: q } },
          { romanized: { contains: q } },
          { english: { contains: q } },
        ],
      }
    : {};

  const rows = await prisma.crystalName.findMany({
    where,
    orderBy: [{ english: "asc" }, { romanized: "asc" }, { id: "asc" }],
    take: limit,
    skip: offset,
  });
  return rows.map(mapCrystalNameRow);
}

export async function listCrystalNameProposals(
  prisma,
  { status = "pending", take = 200 } = {},
) {
  const limit = Math.min(Math.max(Number(take) || 200, 1), 500);
  const st = String(status || "pending").trim().toLowerCase();
  const rows = await prisma.crystalNameProposal.findMany({
    where: st === "all" ? {} : { status: st },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(mapCrystalProposalRow);
}

export async function upsertCrystalNameRow(prisma, args) {
  const amharic = trimCrystalField(args.amharic, "Amharic");
  const romanized = trimCrystalField(args.romanized, "Romanized");
  const english = trimCrystalField(args.english, "English");
  const data = { amharic, romanized, english };

  try {
    if (args.id != null) {
      const id = Number(args.id);
      const existing = await prisma.crystalName.findUnique({ where: { id } });
      if (!existing) throw new Error("Crystal name not found");
      const row = await prisma.crystalName.update({ where: { id }, data });
      return mapCrystalNameRow(row);
    }
    const row = await prisma.crystalName.create({ data });
    return mapCrystalNameRow(row);
  } catch (err) {
    if (err?.code === "P2002") {
      throw new Error(
        "A crystal name with this Amharic|Romanized|English already exists",
      );
    }
    throw err;
  }
}

export async function deleteCrystalNameRow(prisma, id) {
  const numId = Number(id);
  const existing = await prisma.crystalName.findUnique({ where: { id: numId } });
  if (!existing) throw new Error("Crystal name not found");
  await prisma.crystalName.delete({ where: { id: numId } });
  return true;
}

export function applyQualifierToCrystalLabel(baseLabel, qualifierRaw) {
  const qual = String(qualifierRaw || "").trim();
  const parts = String(baseLabel || "")
    .split("|")
    .map((p) => p.trim());
  if (parts.length < 3) {
    const base = String(baseLabel || "").trim();
    if (!base) return qual ? `(${qual})` : "";
    const stripped = base.replace(/^(.*)\(([^()]*)\)\s*$/, "$1").trim() || base;
    return qual ? `${stripped}(${qual})` : stripped;
  }
  const amharic = parts[0];
  let romanized = parts[1];
  const english = parts.slice(2).join("|");
  romanized = romanized.replace(/^(.*)\(([^()]*)\)\s*$/, "$1").trim() || romanized;
  return qual ? `${amharic}|${romanized}(${qual})|${english}` : `${amharic}|${romanized}|${english}`;
}

/** Aliases a proposal may have been stored as on inventory / request rows. */
export function proposalNameAliases(proposal) {
  const set = new Set();
  const add = (value) => {
    const t = String(value || "").trim();
    if (t) set.add(t);
  };
  add(proposal?.rawText);
  add(crystalLabel(proposal || {}));
  const amharic = String(proposal?.amharic || "").trim();
  const romanized = String(proposal?.romanized || "").trim();
  const english = String(proposal?.english || "").trim();
  if (amharic || romanized || english) {
    add([amharic, romanized, english].filter(Boolean).join("|"));
  }
  if (amharic && romanized && english) {
    add(`${amharic}|${romanized}|${english}`);
  }
  return [...set];
}

/**
 * If `stored` matches an old proposal alias (exact or with qualifier),
 * return the rewritten approved/merged label (qualifier preserved).
 */
export function rewriteStoredCrystalName(stored, oldAliases, newLabel) {
  const value = String(stored || "").trim();
  const next = String(newLabel || "").trim();
  if (!value || !next) return null;
  if (value === next) return null;

  const aliases = (oldAliases || [])
    .map((a) => String(a || "").trim())
    .filter(Boolean)
    .filter((a) => a !== next);
  if (aliases.length === 0) return null;

  if (aliases.includes(value)) return next;

  for (const alias of aliases) {
    if (value.startsWith(`${alias}(`) && value.endsWith(")")) {
      const inner = value.slice(alias.length + 1, -1);
      if (inner && !inner.includes("(") && !inner.includes(")")) {
        return applyQualifierToCrystalLabel(next, inner);
      }
    }
  }

  const parts = value.split("|").map((p) => p.trim());
  if (parts.length >= 3) {
    const amharic = parts[0];
    const romanized = parts[1];
    const english = parts.slice(2).join("|");
    const m = romanized.match(/^(.*)\(([^()]*)\)\s*$/);
    const baseRomanized = m ? m[1].trim() : romanized;
    const qualifier = m ? m[2].trim() : "";
    const base = `${amharic}|${baseRomanized}|${english}`;
    if (aliases.includes(base) || aliases.includes(value)) {
      return applyQualifierToCrystalLabel(next, qualifier);
    }
  }

  return null;
}

async function rewriteScalarNameField(prisma, model, field, oldAliases, newLabel) {
  const or = [];
  for (const alias of oldAliases) {
    or.push({ [field]: alias });
    or.push({ [field]: { startsWith: `${alias}(` } });
  }
  if (or.length === 0) return 0;

  const rows = await prisma[model].findMany({
    where: { OR: or },
    select: { id: true, [field]: true },
  });

  let updated = 0;
  for (const row of rows) {
    const rewritten = rewriteStoredCrystalName(row[field], oldAliases, newLabel);
    if (!rewritten || rewritten === row[field]) continue;
    await prisma[model].update({
      where: { id: row.id },
      data: { [field]: rewritten },
    });
    updated += 1;
  }
  return updated;
}

async function rewriteStationIngredientStock(prisma, oldAliases, newLabel) {
  const or = [];
  for (const alias of oldAliases) {
    or.push({ itemName: alias });
    or.push({ itemName: { startsWith: `${alias}(` } });
  }
  if (or.length === 0) return 0;

  const rows = await prisma.stationIngredientStock.findMany({
    where: { OR: or },
  });

  let updated = 0;
  for (const row of rows) {
    const rewritten = rewriteStoredCrystalName(
      row.itemName,
      oldAliases,
      newLabel,
    );
    if (!rewritten || rewritten === row.itemName) continue;

    const clash = await prisma.stationIngredientStock.findUnique({
      where: {
        HotelName_station_itemName: {
          HotelName: row.HotelName,
          station: row.station,
          itemName: rewritten,
        },
      },
    });

    if (clash && clash.id !== row.id) {
      await prisma.stationIngredientStock.update({
        where: { id: clash.id },
        data: { amount: (Number(clash.amount) || 0) + (Number(row.amount) || 0) },
      });
      await prisma.stationIngredientStock.delete({ where: { id: row.id } });
    } else {
      await prisma.stationIngredientStock.update({
        where: { id: row.id },
        data: { itemName: rewritten },
      });
    }
    updated += 1;
  }
  return updated;
}

async function rewriteKitchenBarMonthlySnapshot(prisma, oldAliases, newLabel) {
  const or = [];
  for (const alias of oldAliases) {
    or.push({ itemName: alias });
    or.push({ itemName: { startsWith: `${alias}(` } });
  }
  if (or.length === 0) return 0;

  const rows = await prisma.kitchenBarMonthlySnapshot.findMany({
    where: { OR: or },
  });

  let updated = 0;
  for (const row of rows) {
    const rewritten = rewriteStoredCrystalName(
      row.itemName,
      oldAliases,
      newLabel,
    );
    if (!rewritten || rewritten === row.itemName) continue;

    const clash = await prisma.kitchenBarMonthlySnapshot.findUnique({
      where: {
        HotelName_station_itemName_monthPeriod: {
          HotelName: row.HotelName,
          station: row.station,
          itemName: rewritten,
          monthPeriod: row.monthPeriod,
        },
      },
    });

    if (clash && clash.id !== row.id) {
      await prisma.kitchenBarMonthlySnapshot.update({
        where: { id: clash.id },
        data: {
          totalImpliedSales:
            (Number(clash.totalImpliedSales) || 0) +
            (Number(row.totalImpliedSales) || 0),
          totalShortage:
            (Number(clash.totalShortage) || 0) + (Number(row.totalShortage) || 0),
          totalOverage:
            (Number(clash.totalOverage) || 0) + (Number(row.totalOverage) || 0),
          lastDayClosingOnHand: Number(row.lastDayClosingOnHand) || 0,
          syncedAt: new Date(),
        },
      });
      await prisma.kitchenBarMonthlySnapshot.delete({ where: { id: row.id } });
    } else {
      await prisma.kitchenBarMonthlySnapshot.update({
        where: { id: row.id },
        data: { itemName: rewritten },
      });
    }
    updated += 1;
  }
  return updated;
}

async function rewriteRecipeJsonIngredients(prisma, oldAliases, newLabel) {
  const items = await prisma.item.findMany({
    where: { recipeJson: { not: null } },
    select: { id: true, recipeJson: true },
  });

  let updated = 0;
  for (const item of items) {
    const recipe = item.recipeJson;
    if (!recipe || typeof recipe !== "object") continue;
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients
      : null;
    if (!ingredients?.length) continue;

    let dirty = false;
    const nextIngredients = ingredients.map((ing) => {
      if (!ing || typeof ing !== "object") return ing;
      const rewritten = rewriteStoredCrystalName(
        ing.name,
        oldAliases,
        newLabel,
      );
      if (!rewritten) return ing;
      dirty = true;
      return { ...ing, name: rewritten };
    });
    if (!dirty) continue;

    await prisma.item.update({
      where: { id: item.id },
      data: { recipeJson: { ...recipe, ingredients: nextIngredients } },
    });
    updated += 1;
  }
  return updated;
}

/**
 * After Apex approves/merges a proposal, rewrite every stored use of the
 * provisional name to the final crystal label (all workflow statuses).
 */
export async function propagateCrystalNameRewrite(
  prisma,
  { proposal, newLabel },
) {
  const label = String(newLabel || "").trim();
  if (!label) return { updated: 0 };

  const oldAliases = proposalNameAliases(proposal).filter((a) => a !== label);
  if (oldAliases.length === 0) return { updated: 0 };

  let updated = 0;
  updated += await rewriteScalarNameField(
    prisma,
    "itemRegistration",
    "name",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "itemStatus",
    "name",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "freshBazaar",
    "name",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "purchaseRequest",
    "itemName",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "stockOutRequest",
    "itemNameSnapshot",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "recipeStockConsumption",
    "ingredientName",
    oldAliases,
    label,
  );
  updated += await rewriteScalarNameField(
    prisma,
    "kitchenBarBeginning",
    "itemName",
    oldAliases,
    label,
  );
  updated += await rewriteStationIngredientStock(prisma, oldAliases, label);
  updated += await rewriteKitchenBarMonthlySnapshot(prisma, oldAliases, label);
  updated += await rewriteRecipeJsonIngredients(prisma, oldAliases, label);

  return { updated, aliases: oldAliases, newLabel: label };
}

export async function approveCrystalNameProposalRow(
  prisma,
  { id, reviewedBy, amharic, romanized, english },
) {
  const numId = Number(id);
  const proposal = await prisma.crystalNameProposal.findUnique({
    where: { id: numId },
  });
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}`);
  }

  const triple = resolveApprovalTriple(proposal, {
    amharic,
    romanized,
    english,
  });

  let crystal = await prisma.crystalName.findFirst({
    where: triple,
  });
  if (!crystal) {
    try {
      crystal = await prisma.crystalName.create({
        data: triple,
      });
    } catch (err) {
      if (err?.code === "P2002") {
        crystal = await prisma.crystalName.findFirst({
          where: triple,
        });
      } else {
        throw err;
      }
    }
  }
  if (!crystal) throw new Error("Could not create crystal name");

  const updated = await prisma.crystalNameProposal.update({
    where: { id: numId },
    data: {
      status: "approved",
      amharic: triple.amharic,
      romanized: triple.romanized,
      english: triple.english,
      mergedIntoId: crystal.id,
      reviewedBy: reviewedBy || null,
      reviewedAt: new Date(),
      reviewNote: "Approved as new crystal",
    },
  });

  // Rewrite provisional names everywhere before returning.
  await propagateCrystalNameRewrite(prisma, {
    proposal,
    newLabel: crystalLabel(crystal),
  });

  return {
    proposal: mapCrystalProposalRow(updated),
    crystal: mapCrystalNameRow(crystal),
  };
}

export async function mergeCrystalNameProposalRow(
  prisma,
  { id, targetCrystalNameId, reviewedBy },
) {
  const numId = Number(id);
  const targetId = Number(targetCrystalNameId);
  const proposal = await prisma.crystalNameProposal.findUnique({
    where: { id: numId },
  });
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}`);
  }
  const target = await prisma.crystalName.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("Target crystal name not found");

  const updated = await prisma.crystalNameProposal.update({
    where: { id: numId },
    data: {
      status: "merged",
      mergedIntoId: target.id,
      reviewedBy: reviewedBy || null,
      reviewedAt: new Date(),
      reviewNote: `Merged into ${crystalLabel(target)}`,
    },
  });

  await propagateCrystalNameRewrite(prisma, {
    proposal,
    newLabel: crystalLabel(target),
  });

  return {
    proposal: mapCrystalProposalRow(updated),
    crystal: mapCrystalNameRow(target),
  };
}

export async function rejectCrystalNameProposalRow(
  prisma,
  { id, reason, reviewedBy },
) {
  const numId = Number(id);
  const proposal = await prisma.crystalNameProposal.findUnique({
    where: { id: numId },
  });
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}`);
  }
  const note = String(reason || "").trim().slice(0, 512) || "Rejected";
  const updated = await prisma.crystalNameProposal.update({
    where: { id: numId },
    data: {
      status: "rejected",
      reviewNote: note,
      reviewedBy: reviewedBy || null,
      reviewedAt: new Date(),
    },
  });
  return mapCrystalProposalRow(updated);
}
