import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { resolveSignupPricing, normalizePricingBusinessType } from "./pricingRules.js";
import { parseModulesJson } from "./subscriptionPricing.js";
import {
  quarterlyFeeApplies,
  computeSubscriptionPaidUntil,
} from "./tenantBilling.js";
import { findTenantOwner, ensureTenantAccount } from "./tenantHelpers.js";
import { writeApexAudit } from "./auditLog.js";
import {
  initialCafeOrderModeHistory,
  parseCafeOrderMode,
} from "./cafeOrderMode.js";
import { resolveActiveSalesAgentId } from "./salesAgents.js";

function generateAutoTenantKey() {
  const slug = crypto.randomBytes(12).toString("base64url");
  return `TIN_${slug}`;
}

export async function allocateUniqueTinNumber(preferredTenDigitTin) {
  const tin = String(preferredTenDigitTin || "").trim();
  if (/^\d{10}$/.test(tin)) {
    const taken = await prisma.user.findFirst({ where: { tinNumber: tin } });
    if (taken) throw new Error("This TIN is already registered to a business");
    return tin;
  }
  for (let i = 0; i < 100; i++) {
    const key = generateAutoTenantKey();
    const taken = await prisma.user.findFirst({ where: { tinNumber: key } });
    if (!taken) return key;
  }
  throw new Error("Could not allocate a unique business id");
}

export function ownerRoleForBusinessType(businessType) {
  const bt = normalizePricingBusinessType(businessType);
  return ["Hotel", "Resort", "Pension"].includes(bt) ? "Manager" : "Admin";
}

export function normalizeModulesInput(modules) {
  let modulesJson = modules;
  if (modulesJson == null || modulesJson === "") {
    modulesJson = [];
  } else if (typeof modulesJson === "string") {
    try {
      modulesJson = JSON.parse(modulesJson);
    } catch {
      modulesJson = [];
    }
  }
  if (!Array.isArray(modulesJson)) modulesJson = [];
  return modulesJson.map(String).filter(Boolean);
}

async function createPaymentSubmission({
  tinNumber,
  paymentKind,
  amountETB,
  paymentChannel,
  transactionRef,
  submittedByUserId,
  quarterNumber = null,
}) {
  await prisma.tenant_payment_submission.updateMany({
    where: { tinNumber, paymentKind, status: "pending" },
    data: { status: "rejected" },
  });

  return prisma.tenant_payment_submission.create({
    data: {
      tinNumber,
      paymentKind,
      amountETB,
      paymentChannel: String(paymentChannel).trim(),
      transactionRef: String(transactionRef).trim(),
      submittedByUserId,
      quarterNumber,
      status: "pending",
    },
  });
}

export async function applySetupApproval(apex, tin, owner) {
  const now = new Date();
  const billingApplies = quarterlyFeeApplies(owner.quarterlyFeeETB ?? 0);

  const pending = await prisma.tenant_payment_submission.findFirst({
    where: { tinNumber: tin, paymentKind: "setup", status: "pending" },
    orderBy: { submittedAt: "desc" },
  });
  if (pending) {
    await prisma.tenant_payment_submission.update({
      where: { id: pending.id },
      data: {
        status: "approved",
        approvedAt: now,
        approvedByApexMemberId: apex.apexMemberId,
      },
    });
  }

  await prisma.user.update({
    where: { id: owner.id },
    data: {
      setupFeeApproved: true,
      subscriptionPaymentApproved: billingApplies,
      paidQuartersCount: billingApplies ? 1 : 0,
      billingStartedAt: billingApplies ? now : null,
      subscriptionPaidUntil: billingApplies
        ? computeSubscriptionPaidUntil(now, 1, owner.businessType ?? null)
        : null,
    },
  });

  await ensureTenantAccount(tin, owner);
}

export async function createTenantOwnerUser({
  apex,
  hotelName,
  userName,
  password,
  businessType,
  modules,
  tinNumber,
  logoUrl = null,
  paymentChannel = null,
  paymentTransactionRef = null,
  confirmPaymentReceived = false,
  isIllustrationTenant = false,
  billingNotes = null,
  cafeOrderMode = "digital",
  salesAgentId = null,
}) {
  const userNameNorm = String(userName).trim();
  if (!userNameNorm) throw new Error("Username is required");
  if (!String(password || "").trim()) throw new Error("Password is required");
  if (!String(hotelName || "").trim()) throw new Error("Business name is required");

  const existingUsername = await prisma.user.findUnique({
    where: { UserName: userNameNorm },
  });
  if (existingUsername) throw new Error("Username already exists");

  const resolvedTin = await allocateUniqueTinNumber(tinNumber);
  const modulesJson = normalizeModulesInput(modules);
  const bt = normalizePricingBusinessType(businessType);
  const role = ownerRoleForBusinessType(bt);
  const effectiveFees = await resolveSignupPricing(bt, modulesJson);
  const setupNum = effectiveFees.setupFeeETB;
  const quarterlyNum = effectiveFees.quarterlyFeeETB;
  const billingApplies = quarterlyFeeApplies(quarterlyNum);
  const illustration = Boolean(isIllustrationTenant);
  const paymentConfirmed = Boolean(confirmPaymentReceived);

  const needsPaymentApproval =
    !illustration && !paymentConfirmed && billingApplies && setupNum > 0;

  if (
    needsPaymentApproval &&
    (!paymentChannel ||
      !paymentTransactionRef ||
      String(paymentTransactionRef).trim().length < 4)
  ) {
    throw new Error(
      "Setup fee payment channel and transaction reference are required (or mark payment as received)",
    );
  }

  const now = new Date();
  const autoApproved = illustration || paymentConfirmed || !needsPaymentApproval;
  const hashedPassword = await bcrypt.hash(String(password), 12);

  const created = await prisma.user.create({
    data: {
      UserName: userNameNorm,
      Password: hashedPassword,
      Role: role,
      HotelName: String(hotelName).trim(),
      LogoUrl: logoUrl ? String(logoUrl).trim() : null,
      tinNumber: resolvedTin,
      businessType: bt,
      modules: modulesJson,
      setupFeeETB: setupNum,
      quarterlyFeeETB: quarterlyNum,
      pricingRuleId: effectiveFees.pricingRuleId,
      feesManuallySet: false,
      paymentChannel: paymentChannel ? String(paymentChannel).trim() : null,
      paymentTransactionRef: paymentTransactionRef
        ? String(paymentTransactionRef).trim()
        : null,
      setupFeeApproved: autoApproved,
      subscriptionPaymentApproved: autoApproved && billingApplies,
      billingHold: false,
      isIllustrationTenant: illustration,
      billingNotes: billingNotes ? String(billingNotes).trim() : null,
      paidQuartersCount: autoApproved && billingApplies ? 1 : 0,
      billingStartedAt: autoApproved && billingApplies ? now : null,
      subscriptionPaidUntil:
        autoApproved && billingApplies
          ? computeSubscriptionPaidUntil(now, 1, bt)
          : null,
    },
  });

  if (
    needsPaymentApproval &&
    paymentChannel &&
    paymentTransactionRef &&
    String(paymentTransactionRef).trim() !== ""
  ) {
    await createPaymentSubmission({
      tinNumber: resolvedTin,
      paymentKind: "setup",
      amountETB: setupNum,
      paymentChannel,
      transactionRef: paymentTransactionRef,
      submittedByUserId: created.id,
    });
  }

  await ensureTenantAccount(resolvedTin, created);

  const hasCafe = modulesJson.map(String).includes("Cafe and Restaurant");
  const resolvedMode = hasCafe ? parseCafeOrderMode(cafeOrderMode) : "digital";
  const resolvedSalesAgentId = await resolveActiveSalesAgentId(salesAgentId);
  await prisma.tenant_account.update({
    where: { tinNumber: resolvedTin },
    data: {
      cafeOrderMode: resolvedMode,
      cafeOrderModeHistory: initialCafeOrderModeHistory(resolvedMode, now),
      salesAgentId: resolvedSalesAgentId,
    },
  });

  if (paymentConfirmed && !illustration && setupNum > 0) {
    await applySetupApproval(apex, resolvedTin, created);
  }

  await writeApexAudit(apex.apexMemberId, "apex_create_tenant", {
    targetTinNumber: resolvedTin,
    targetUserId: created.id,
    payload: {
      ownerUserName: userNameNorm,
      confirmPaymentReceived: paymentConfirmed,
      isIllustrationTenant: illustration,
    },
  });

  return {
    tinNumber: resolvedTin,
    hotelDisplayName: created.HotelName,
    ownerUserName: created.UserName,
    ownerRole: created.Role,
    setupFeeETB: setupNum,
    setupFeeApproved: autoApproved || paymentConfirmed,
    userId: created.id,
  };
}

export async function resolveTenantContextForOwner(tinNumber) {
  const tin = String(tinNumber || "").trim();
  if (!tin) throw new Error("TIN is required");

  const existingOwner = await findTenantOwner(tin);
  if (existingOwner) {
    throw new Error("This property already has an owner login");
  }

  const account = await prisma.tenant_account.findUnique({ where: { tinNumber: tin } });
  const staffUsers = await prisma.user.findMany({
    where: { tinNumber: tin },
    orderBy: { id: "asc" },
    take: 1,
  });
  const sampleUser = staffUsers[0] ?? null;

  if (!account && !sampleUser) {
    throw new Error("Tenant not found — no property record for this TIN");
  }

  return {
    tin,
    hotelDisplayName:
      account?.hotelDisplayName ?? sampleUser?.HotelName ?? tin,
    businessType:
      account?.businessType ?? sampleUser?.businessType ?? "Cafe and Restaurant",
    modules: parseModulesJson(account?.modules ?? sampleUser?.modules),
    logoUrl: account?.logoUrl ?? sampleUser?.LogoUrl ?? null,
    setupFeeETB: sampleUser?.setupFeeETB ?? null,
    quarterlyFeeETB: sampleUser?.quarterlyFeeETB ?? null,
  };
}

export async function createOwnerForExistingTenant({
  apex,
  tinNumber,
  userName,
  password,
  logoUrl = null,
  paymentChannel = null,
  paymentTransactionRef = null,
  confirmPaymentReceived = false,
}) {
  const ctx = await resolveTenantContextForOwner(tinNumber);
  const userNameNorm = String(userName).trim();
  if (!userNameNorm) throw new Error("Username is required");

  const existingUsername = await prisma.user.findUnique({
    where: { UserName: userNameNorm },
  });
  if (existingUsername) throw new Error("Username already exists");

  const bt = normalizePricingBusinessType(ctx.businessType);
  const role = ownerRoleForBusinessType(bt);
  const modulesJson = ctx.modules.length ? ctx.modules : ["Credentials(Common)"];
  const effectiveFees = await resolveSignupPricing(bt, modulesJson);
  const setupNum =
    ctx.setupFeeETB != null ? Number(ctx.setupFeeETB) : effectiveFees.setupFeeETB;
  const quarterlyNum =
    ctx.quarterlyFeeETB != null
      ? Number(ctx.quarterlyFeeETB)
      : effectiveFees.quarterlyFeeETB;
  const billingApplies = quarterlyFeeApplies(quarterlyNum);
  const paymentConfirmed = Boolean(confirmPaymentReceived);
  const needsPaymentApproval = !paymentConfirmed && billingApplies && setupNum > 0;

  if (
    needsPaymentApproval &&
    (!paymentChannel ||
      !paymentTransactionRef ||
      String(paymentTransactionRef).trim().length < 4)
  ) {
    throw new Error(
      "Setup fee payment channel and transaction reference are required (or mark payment as received)",
    );
  }

  const now = new Date();
  const autoApproved = paymentConfirmed || !needsPaymentApproval;
  const hashedPassword = await bcrypt.hash(String(password), 12);

  const created = await prisma.user.create({
    data: {
      UserName: userNameNorm,
      Password: hashedPassword,
      Role: role,
      HotelName: ctx.hotelDisplayName,
      LogoUrl: logoUrl ? String(logoUrl).trim() : ctx.logoUrl,
      tinNumber: ctx.tin,
      businessType: bt,
      modules: modulesJson,
      setupFeeETB: setupNum,
      quarterlyFeeETB: quarterlyNum,
      pricingRuleId: effectiveFees.pricingRuleId,
      feesManuallySet: false,
      paymentChannel: paymentChannel ? String(paymentChannel).trim() : null,
      paymentTransactionRef: paymentTransactionRef
        ? String(paymentTransactionRef).trim()
        : null,
      setupFeeApproved: autoApproved,
      subscriptionPaymentApproved: autoApproved && billingApplies,
      billingHold: false,
      isIllustrationTenant: false,
      paidQuartersCount: autoApproved && billingApplies ? 1 : 0,
      billingStartedAt: autoApproved && billingApplies ? now : null,
      subscriptionPaidUntil:
        autoApproved && billingApplies
          ? computeSubscriptionPaidUntil(now, 1, bt)
          : null,
    },
  });

  if (
    needsPaymentApproval &&
    paymentChannel &&
    paymentTransactionRef &&
    String(paymentTransactionRef).trim() !== ""
  ) {
    await createPaymentSubmission({
      tinNumber: ctx.tin,
      paymentKind: "setup",
      amountETB: setupNum,
      paymentChannel,
      transactionRef: paymentTransactionRef,
      submittedByUserId: created.id,
    });
  }

  await ensureTenantAccount(ctx.tin, created);

  if (paymentConfirmed && setupNum > 0) {
    await applySetupApproval(apex, ctx.tin, created);
  }

  await writeApexAudit(apex.apexMemberId, "apex_create_tenant_owner", {
    targetTinNumber: ctx.tin,
    targetUserId: created.id,
    payload: { ownerUserName: userNameNorm, confirmPaymentReceived: paymentConfirmed },
  });

  return {
    tinNumber: ctx.tin,
    hotelDisplayName: created.HotelName,
    ownerUserName: created.UserName,
    ownerRole: created.Role,
    setupFeeETB: setupNum,
    setupFeeApproved: autoApproved || paymentConfirmed,
    userId: created.id,
  };
}

export async function listTenantsWithoutOwner() {
  const accounts = await prisma.tenant_account.findMany({
    orderBy: { hotelDisplayName: "asc" },
  });

  const rows = [];
  for (const account of accounts) {
    const owner = await findTenantOwner(account.tinNumber);
    if (owner) continue;
    const staffCount = await prisma.user.count({
      where: { tinNumber: account.tinNumber },
    });
    rows.push({
      tinNumber: account.tinNumber,
      hotelDisplayName: account.hotelDisplayName,
      businessType: account.businessType,
      hasStaffUsers: staffCount > 0,
    });
  }
  return rows;
}

export async function createPortfolioOwnerAccount({
  apex,
  userName,
  password,
  displayName = null,
  phone = null,
  email = null,
  linkTinNumber = null,
}) {
  const userNameNorm = String(userName).trim();
  if (!userNameNorm) throw new Error("Username is required");
  if (!String(password || "").trim()) throw new Error("Password is required");

  const existing = await prisma.owner_account.findUnique({
    where: { UserName: userNameNorm },
  });
  if (existing) throw new Error("Owner account username already exists");

  const hashedPassword = await bcrypt.hash(String(password), 12);
  const owner = await prisma.owner_account.create({
    data: {
      UserName: userNameNorm,
      Password: hashedPassword,
      displayName: displayName ? String(displayName).trim() : null,
      phone: phone ? String(phone).trim() : null,
      email: email ? String(email).trim() : null,
      isActive: true,
    },
  });

  if (linkTinNumber) {
    await linkOwnerToProperty(owner.id, linkTinNumber, null);
  }

  await writeApexAudit(apex.apexMemberId, "apex_create_owner_account", {
    targetTinNumber: linkTinNumber ? String(linkTinNumber).trim() : null,
    payload: { ownerAccountId: owner.id, ownerUserName: userNameNorm },
  });

  return owner;
}

export async function linkOwnerToProperty(ownerAccountId, tinNumber, label = null) {
  const tin = String(tinNumber || "").trim();
  if (!tin) throw new Error("TIN is required");

  const owner = await prisma.owner_account.findUnique({
    where: { id: ownerAccountId },
  });
  if (!owner) throw new Error("Owner account not found");

  const account = await prisma.tenant_account.findUnique({ where: { tinNumber: tin } });
  const tenantOwner = await findTenantOwner(tin);
  if (!account && !tenantOwner) {
    throw new Error("Property not found for this TIN");
  }

  await prisma.owner_property.upsert({
    where: {
      ownerId_tinNumber: { ownerId: ownerAccountId, tinNumber: tin },
    },
    create: {
      ownerId: ownerAccountId,
      tinNumber: tin,
      label: label ? String(label).trim() : null,
    },
    update: {
      label: label ? String(label).trim() : null,
    },
  });

  return true;
}

export async function listOwnerAccounts(search) {
  const q = String(search || "").trim().toLowerCase();
  const rows = await prisma.owner_account.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { properties: true } } },
  });

  return rows
    .filter((row) => {
      if (!q) return true;
      const hay = [
        row.UserName,
        row.displayName,
        row.phone,
        row.email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    })
    .map((row) => ({
      id: row.id,
      userName: row.UserName,
      displayName: row.displayName,
      phone: row.phone,
      email: row.email,
      isActive: row.isActive,
      propertyCount: row._count.properties,
      createdAt: row.createdAt,
    }));
}
