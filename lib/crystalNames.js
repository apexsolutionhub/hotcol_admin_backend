/**
 * Crystal name helpers for Apex CRUD (shared crystal_name + proposals with hotcol-user).
 */

export function trimCrystalField(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label} is required`);
  if (s.length > 255) throw new Error(`${label} must be at most 255 characters`);
  return s;
}

export function crystalLabel(row) {
  return `${row.amharic}|${row.romanized}|${row.english}`;
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

export async function approveCrystalNameProposalRow(
  prisma,
  { id, reviewedBy },
) {
  const numId = Number(id);
  const proposal = await prisma.crystalNameProposal.findUnique({
    where: { id: numId },
  });
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}`);
  }

  let crystal = await prisma.crystalName.findFirst({
    where: {
      amharic: proposal.amharic,
      romanized: proposal.romanized,
      english: proposal.english,
    },
  });
  if (!crystal) {
    try {
      crystal = await prisma.crystalName.create({
        data: {
          amharic: proposal.amharic,
          romanized: proposal.romanized,
          english: proposal.english,
        },
      });
    } catch (err) {
      if (err?.code === "P2002") {
        crystal = await prisma.crystalName.findFirst({
          where: {
            amharic: proposal.amharic,
            romanized: proposal.romanized,
            english: proposal.english,
          },
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
      mergedIntoId: crystal.id,
      reviewedBy: reviewedBy || null,
      reviewedAt: new Date(),
      reviewNote: "Approved as new crystal",
    },
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
