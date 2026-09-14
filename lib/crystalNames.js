/**
 * Crystal name helpers for Apex CRUD (shared crystal_name table with hotcol-user).
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
