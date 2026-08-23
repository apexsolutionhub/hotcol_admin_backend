import { prisma } from "./prisma.js";

export function mapSalesAgentRow(row, tenantCount = 0) {
  return {
    id: row.id,
    displayName: row.displayName,
    phone: row.phone ?? null,
    email: row.email ?? null,
    city: row.city ?? null,
    notes: row.notes ?? null,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
    tenantCount: Number(tenantCount) || 0,
  };
}

export function salesAgentNameFromAccount(account) {
  const name = account?.salesAgent?.displayName;
  return name != null && String(name).trim() !== "" ? String(name).trim() : null;
}

export async function resolveActiveSalesAgentId(salesAgentId) {
  if (salesAgentId == null || salesAgentId === "") return null;
  const id = Number(salesAgentId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const row = await prisma.sales_agent.findUnique({ where: { id } });
  if (!row) throw new Error("Selected sales agent was not found");
  if (!row.isActive) throw new Error("That sales agent is no longer active");
  return id;
}

export async function listSalesAgents({ activeOnly = false } = {}) {
  const rows = await prisma.sales_agent.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { displayName: "asc" },
    include: { _count: { select: { tenants: true } } },
  });
  return rows.map((row) => mapSalesAgentRow(row, row._count?.tenants));
}
