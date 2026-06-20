import { prisma } from "./prisma.js";
import { parseModulesJson } from "./subscriptionPricing.js";
import {
  computeSubscriptionPeriodStatus,
  tenantBillingRowFromOwner,
} from "./tenantBilling.js";

export async function findTenantOwner(tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) return null;
  return prisma.user.findFirst({
    where: { tinNumber: tin, Role: { in: ["Admin", "Manager"] } },
    orderBy: { id: "asc" },
  });
}

export async function ensureTenantAccount(tinNumber, owner) {
  const tin = String(tinNumber).trim();
  let account = await prisma.tenant_account.findUnique({ where: { tinNumber: tin } });
  if (account) return account;

  return prisma.tenant_account.create({
    data: {
      tinNumber: tin,
      hotelDisplayName: owner?.HotelName ?? tin,
      businessType: owner?.businessType ?? null,
      logoUrl: owner?.LogoUrl ?? null,
      modules: owner?.modules ?? [],
      accountStatus: "active",
    },
  });
}

export async function syncOwnerModulesToAllUsers(tinNumber, modulesJson) {
  await prisma.user.updateMany({
    where: { tinNumber },
    data: { modules: modulesJson },
  });
}

export function ownerToBillingSnapshot(owner) {
  return tenantBillingRowFromOwner(owner);
}

export function buildTenantListItem(owner, account, subscriptionStatus, unreadFeedback = 0) {
  return {
    tinNumber: owner.tinNumber ?? "",
    hotelDisplayName: account?.hotelDisplayName ?? owner.HotelName,
    businessType: owner.businessType,
    accountStatus: account?.accountStatus ?? "active",
    subscriptionStatus,
    setupFeeApproved: Boolean(owner.setupFeeApproved),
    setupFeeETB: owner.setupFeeETB ?? 0,
    quarterlyFeeETB: owner.quarterlyFeeETB ?? 0,
    ownerUserName: owner.UserName,
    createdAt: owner.createdAt,
    billingHold: Boolean(owner.billingHold),
    isIllustrationTenant: Boolean(owner.isIllustrationTenant),
    unreadFeedback,
  };
}

export async function loadTenantAccountsByTin(tins) {
  if (!tins.length) return new Map();
  const rows = await prisma.tenant_account.findMany({
    where: { tinNumber: { in: tins } },
  });
  return new Map(rows.map((r) => [r.tinNumber, r]));
}

export async function loadUnreadFeedbackCountByTin() {
  const unreadByThread = await prisma.tenant_feedback_message.groupBy({
    by: ["threadId"],
    where: { senderSide: "tenant", readByApex: false },
    _count: { _all: true },
  });
  if (unreadByThread.length === 0) return new Map();

  const threadIds = unreadByThread.map((r) => r.threadId);
  const threads = await prisma.tenant_feedback_thread.findMany({
    where: { id: { in: threadIds } },
    select: { id: true, tinNumber: true },
  });
  const threadToTin = new Map(threads.map((t) => [t.id, t.tinNumber]));
  const byTin = new Map();
  for (const row of unreadByThread) {
    const tin = threadToTin.get(row.threadId);
    if (!tin) continue;
    byTin.set(tin, (byTin.get(tin) ?? 0) + row._count._all);
  }
  return byTin;
}

export async function getOrCreateFeedbackThreadForTin(tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) throw new Error("TIN required");

  const existing = await prisma.tenant_feedback_thread.findUnique({
    where: { tinNumber: tin },
  });
  if (existing) return existing;

  const [account, owner] = await Promise.all([
    prisma.tenant_account.findUnique({ where: { tinNumber: tin } }),
    findTenantOwner(tin),
  ]);
  if (!account && !owner) throw new Error("Tenant not found");

  return prisma.tenant_feedback_thread.create({
    data: {
      tinNumber: tin,
      hotelDisplayName: account?.hotelDisplayName ?? owner?.HotelName ?? tin,
      businessType: account?.businessType ?? owner?.businessType ?? null,
    },
  });
}

export async function loadOwnerHotelNamesByTin(tins) {
  if (!tins.length) return new Map();
  const owners = await prisma.user.findMany({
    where: {
      tinNumber: { in: tins },
      Role: { in: ["Admin", "Manager"] },
    },
    orderBy: { id: "asc" },
  });
  const map = new Map();
  for (const o of owners) {
    const tin =
      o.tinNumber != null && String(o.tinNumber).trim() !== ""
        ? String(o.tinNumber).trim()
        : String(o.HotelName).trim();
    if (!map.has(tin)) map.set(tin, o.HotelName);
  }
  return map;
}

export function accountOrOwnerFallback(account, owner, tin) {
  if (account) return account;
  return {
    tinNumber: tin,
    hotelDisplayName: owner?.HotelName ?? tin,
    accountStatus: "active",
  };
}

export async function listDistinctTenantOwners() {
  const owners = await prisma.user.findMany({
    where: { Role: { in: ["Admin", "Manager"] } },
    orderBy: { createdAt: "desc" },
  });

  const byTin = new Map();
  for (const row of owners) {
    const tin =
      row.tinNumber != null && String(row.tinNumber).trim() !== ""
        ? String(row.tinNumber).trim()
        : String(row.HotelName).trim();
    if (!byTin.has(tin)) byTin.set(tin, row);
  }
  return [...byTin.values()];
}

export async function tenantUsersForTin(tinNumber) {
  return prisma.user.findMany({
    where: { tinNumber: tinNumber },
    orderBy: [{ Role: "asc" }, { UserName: "asc" }],
    select: {
      id: true,
      UserName: true,
      Role: true,
      loginDisabled: true,
      loginDisabledReason: true,
      createdAt: true,
    },
  });
}

export function modulesArrayToJson(modules) {
  const list = parseModulesJson(modules);
  return list;
}
