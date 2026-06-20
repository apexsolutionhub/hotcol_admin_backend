import { prisma } from "./prisma.js";
import { loadTenantAccountsByTin } from "./tenantHelpers.js";

export const BUSINESS_TYPE_BUCKETS = [
  { key: "Cafe and Restaurant", label: "Café & Restaurant" },
  { key: "Hotel", label: "Hotel" },
  { key: "Resort", label: "Resort" },
  { key: "Pension", label: "Pension" },
  { key: "Other", label: "Other" },
];

export function normalizeBusinessType(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Other";
  const lower = s.toLowerCase();
  if (
    lower === "cafe" ||
    lower === "café" ||
    lower === "restaurant" ||
    lower === "cafe and restaurant" ||
    lower === "café & restaurant"
  ) {
    return "Cafe and Restaurant";
  }
  if (lower === "hotel") return "Hotel";
  if (lower === "resort") return "Resort";
  if (lower === "pension") return "Pension";
  return "Other";
}

export function businessTypeLabel(key) {
  return BUSINESS_TYPE_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

export function countTenantsByBusinessType(owners) {
  const counts = new Map(BUSINESS_TYPE_BUCKETS.map((b) => [b.key, 0]));
  for (const owner of owners) {
    const key = normalizeBusinessType(owner.businessType);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return BUSINESS_TYPE_BUCKETS.map((b) => ({
    businessType: b.key,
    label: b.label,
    count: counts.get(b.key) ?? 0,
  })).filter((row) => row.count > 0 || row.businessType !== "Other");
}

export async function loadUserMonitoringCounts() {
  const [totalUsers, disabledUsers] = await Promise.all([
    prisma.user.count({ where: { tinNumber: { not: null } } }),
    prisma.user.count({ where: { tinNumber: { not: null }, loginDisabled: true } }),
  ]);
  return { totalUsers, disabledUsers };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function loadTenantOperationalSnapshot(tinNumber) {
  const tin = String(tinNumber).trim();
  const since = startOfToday();

  const openStatusFilter = {
    OR: [
      { status: null },
      {
        status: {
          notIn: ["Completed", "Cancelled", "completed", "cancelled"],
        },
      },
    ],
  };

  const [
    staffCount,
    ordersToday,
    openOrders,
    pendingPurchaseRequests,
    pendingStockOutRequests,
    pendingItemRegistrations,
  ] = await Promise.all([
    prisma.user.count({ where: { tinNumber: tin } }),
    prisma.order.count({ where: { HotelName: tin, createdAt: { gte: since } } }),
    prisma.order.count({ where: { HotelName: tin, ...openStatusFilter } }),
    prisma.purchaseRequest.count({
      where: {
        HotelName: tin,
        status: { startsWith: "PENDING" },
      },
    }),
    prisma.stockOutRequest.count({
      where: {
        HotelName: tin,
        status: { in: ["PENDING", "PENDING_CC", "CHECKED_CC", "PENDING_FINANCE", "PENDING_MANAGER"] },
      },
    }),
    prisma.itemRegistration.count({
      where: {
        HotelName: tin,
        approvalStatus: { startsWith: "PENDING" },
      },
    }),
  ]);

  return {
    staffCount,
    ordersToday,
    openOrders,
    pendingPurchaseRequests,
    pendingStockOutRequests,
    pendingItemRegistrations,
  };
}

export async function listTenantUsersForMonitoring({
  search,
  businessType,
  loginDisabledOnly,
  tinNumber,
  limit = 100,
}) {
  const take = Math.min(Math.max(limit, 1), 200);
  const where = { tinNumber: { not: null } };
  if (tinNumber) where.tinNumber = String(tinNumber).trim();
  if (loginDisabledOnly) where.loginDisabled = true;

  let rows = await prisma.user.findMany({
    where,
    orderBy: [{ tinNumber: "asc" }, { Role: "asc" }, { UserName: "asc" }],
    take: 500,
    select: {
      id: true,
      UserName: true,
      Role: true,
      tinNumber: true,
      businessType: true,
      HotelName: true,
      loginDisabled: true,
      loginDisabledReason: true,
      createdAt: true,
    },
  });

  if (businessType) {
    const bucket = String(businessType).trim();
    rows = rows.filter((u) => normalizeBusinessType(u.businessType) === bucket);
  }

  const q = String(search || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((u) => {
      const hay = `${u.UserName} ${u.Role} ${u.tinNumber} ${u.HotelName} ${u.businessType}`.toLowerCase();
      return hay.includes(q);
    });
  }

  rows = rows.slice(0, take);
  const tins = [...new Set(rows.map((r) => String(r.tinNumber).trim()).filter(Boolean))];
  const accountMap = await loadTenantAccountsByTin(tins);

  return rows.map((u) => {
    const tin = String(u.tinNumber).trim();
    const account = accountMap.get(tin);
    return {
      id: u.id,
      userName: u.UserName,
      role: u.Role,
      tinNumber: tin,
      hotelDisplayName: account?.hotelDisplayName ?? u.HotelName ?? tin,
      businessType: normalizeBusinessType(u.businessType),
      loginDisabled: Boolean(u.loginDisabled),
      loginDisabledReason: u.loginDisabledReason,
      createdAt: u.createdAt,
    };
  });
}
