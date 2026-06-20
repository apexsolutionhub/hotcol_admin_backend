import bcrypt from "bcryptjs";
import { DateTimeResolver, GraphQLJSON } from "graphql-scalars";
import { signApexToken } from "./lib/apexAuth.js";
import { prisma } from "./lib/prisma.js";
import { assertApex } from "./lib/apexAuth.js";
import { writeApexAudit } from "./lib/auditLog.js";
import {
  quarterlyFeeApplies,
  tenantBillingRowFromOwner,
  computeSubscriptionPeriodStatus,
  computePaidUntilForOwner,
} from "./lib/tenantBilling.js";
import {
  computeSubscriptionPaidUntil,
  subscriptionRenewalPaymentKind,
} from "./lib/subscriptionBillingPeriod.js";
import { parseModulesJson } from "./lib/subscriptionPricing.js";
import {
  buildModulesKey,
  listPricingRules,
  normalizePricingBusinessType,
  resolveSignupPricing,
} from "./lib/pricingRules.js";
import {
  findTenantOwner,
  ensureTenantAccount,
  syncOwnerModulesToAllUsers,
  buildTenantListItem,
  listDistinctTenantOwners,
  tenantUsersForTin,
  loadTenantAccountsByTin,
  loadUnreadFeedbackCountByTin,
  loadOwnerHotelNamesByTin,
  accountOrOwnerFallback,
  getOrCreateFeedbackThreadForTin,
} from "./lib/tenantHelpers.js";
import {
  countTenantsByBusinessType,
  loadUserMonitoringCounts,
  loadTenantOperationalSnapshot,
  listTenantUsersForMonitoring,
  normalizeBusinessType,
} from "./lib/monitoringHelpers.js";

async function mapPaymentRow(row, hotelDisplayName) {
  return {
    ...row,
    hotelDisplayName: hotelDisplayName ?? null,
  };
}

function mapPricingRuleRow(row) {
  return {
    id: row.id,
    businessType: row.businessType,
    modulesKey: row.modulesKey,
    modules: parseModulesJson(row.modules),
    setupFeeETB: row.setupFeeETB,
    quarterlyFeeETB: row.quarterlyFeeETB,
    description: row.description,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt,
  };
}

async function catalogFeePatch(businessType, modules) {
  const fees = await resolveSignupPricing(businessType, modules);
  return {
    setupFeeETB: fees.setupFeeETB,
    quarterlyFeeETB: fees.quarterlyFeeETB,
    pricingRuleId: fees.pricingRuleId,
    feesManuallySet: false,
  };
}

export const resolvers = {
  DateTime: DateTimeResolver,
  JSON: GraphQLJSON,

  Query: {
    apexMe: async (_, __, context) => {
      const apex = assertApex(context);
      const member = await prisma.apex_team_member.findUnique({
        where: { id: apex.apexMemberId },
      });
      if (!member?.isActive) throw new Error("Member inactive");
      return {
        id: member.id,
        UserName: member.UserName,
        displayName: member.displayName,
        role: member.role,
      };
    },

    apexDashboardSummary: async (_, __, context) => {
      assertApex(context);
      const [
        pendingSetupPayments,
        pendingQuarterlyPayments,
        pendingYearlyPayments,
        unreadFeedback,
        suspendedTenants,
        bannedTenants,
        owners,
        userCounts,
        pendingModuleRequests,
      ] = await Promise.all([
        prisma.tenant_payment_submission.count({
          where: { paymentKind: "setup", status: "pending" },
        }),
        prisma.tenant_payment_submission.count({
          where: { paymentKind: "quarterly", status: "pending" },
        }),
        prisma.tenant_payment_submission.count({
          where: { paymentKind: "yearly", status: "pending" },
        }),
        prisma.tenant_feedback_message.count({
          where: { senderSide: "tenant", readByApex: false },
        }),
        prisma.tenant_account.count({ where: { accountStatus: "suspended" } }),
        prisma.tenant_account.count({ where: { accountStatus: "banned" } }),
        listDistinctTenantOwners(),
        loadUserMonitoringCounts(),
        prisma.tenant_module_change_request.count({ where: { status: "pending" } }),
      ]);

      const now = new Date();
      const trialCutoff = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      let setupPendingTenants = 0;
      let billingHoldTenants = 0;
      let graceOrExpiredTenants = 0;
      let trialsEndingSoon = 0;

      for (const owner of owners) {
        const sub = tenantBillingRowFromOwner(owner);
        const status = computeSubscriptionPeriodStatus(sub, now);
        if (status === "setup_pending") setupPendingTenants += 1;
        if (status === "on_hold" || Boolean(owner.billingHold)) billingHoldTenants += 1;
        if (status === "grace" || status === "expired") graceOrExpiredTenants += 1;
        if (owner.freeTrialEndsAt) {
          const end = new Date(owner.freeTrialEndsAt);
          if (
            !Number.isNaN(end.getTime()) &&
            end > now &&
            end <= trialCutoff &&
            !owner.isIllustrationTenant
          ) {
            trialsEndingSoon += 1;
          }
        }
      }

      return {
        pendingSetupPayments,
        pendingQuarterlyPayments,
        pendingYearlyPayments,
        unreadFeedback,
        suspendedTenants,
        bannedTenants,
        setupPendingTenants,
        billingHoldTenants,
        graceOrExpiredTenants,
        trialsEndingSoon,
        totalTenants: owners.length,
        totalUsers: userCounts.totalUsers,
        disabledUsers: userCounts.disabledUsers,
        pendingModuleRequests,
        tenantsByBusinessType: countTenantsByBusinessType(owners),
      };
    },

    apexTenants: async (_, { search, businessType }, context) => {
      assertApex(context);
      const owners = await listDistinctTenantOwners();
      const q = String(search || "").trim().toLowerCase();
      const typeFilter = businessType ? String(businessType).trim() : null;

      const tins = owners.map((owner) =>
        owner.tinNumber != null && String(owner.tinNumber).trim() !== ""
          ? String(owner.tinNumber).trim()
          : String(owner.HotelName).trim(),
      );

      const [accountMap, unreadByTin] = await Promise.all([
        loadTenantAccountsByTin(tins),
        loadUnreadFeedbackCountByTin(),
      ]);

      const items = [];
      for (const owner of owners) {
        const tin =
          owner.tinNumber != null && String(owner.tinNumber).trim() !== ""
            ? String(owner.tinNumber).trim()
            : String(owner.HotelName).trim();
        const account = accountOrOwnerFallback(accountMap.get(tin), owner, tin);
        const sub = tenantBillingRowFromOwner(owner);
        const subscriptionStatus = computeSubscriptionPeriodStatus(sub);

        if (typeFilter && normalizeBusinessType(owner.businessType) !== typeFilter) {
          continue;
        }

        if (q) {
          const hay = `${account.hotelDisplayName} ${tin} ${owner.UserName}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        items.push(
          buildTenantListItem(
            owner,
            account,
            subscriptionStatus,
            unreadByTin.get(tin) ?? 0,
          ),
        );
      }

      return items;
    },

    apexTenantDetail: async (_, { tinNumber }, context) => {
      assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const account = await ensureTenantAccount(tin, owner);
      const sub = tenantBillingRowFromOwner(owner);
      const users = await tenantUsersForTin(tin);
      const recentPayments = await prisma.tenant_payment_submission.findMany({
        where: { tinNumber: tin },
        orderBy: { submittedAt: "desc" },
        take: 20,
      });
      const operationalSnapshot = await loadTenantOperationalSnapshot(tin);
      const modules = parseModulesJson(account.modules ?? owner.modules);
      const suggested = await resolveSignupPricing(owner.businessType, modules);
      const setupFeeETB = owner.setupFeeETB ?? 0;
      const quarterlyFeeETB = owner.quarterlyFeeETB ?? 0;

      return {
        tinNumber: tin,
        hotelDisplayName: account.hotelDisplayName,
        businessType: owner.businessType,
        logoUrl: account.logoUrl ?? owner.LogoUrl,
        accountStatus: account.accountStatus,
        subscriptionStatus: computeSubscriptionPeriodStatus(sub),
        modules,
        setupFeeETB,
        quarterlyFeeETB,
        suggestedSetupFeeETB: suggested.setupFeeETB,
        suggestedQuarterlyFeeETB: suggested.quarterlyFeeETB,
        feesManuallySet: Boolean(owner.feesManuallySet),
        pricingRuleId: owner.pricingRuleId ?? suggested.pricingRuleId,
        feesMatchCatalog:
          setupFeeETB === suggested.setupFeeETB &&
          quarterlyFeeETB === suggested.quarterlyFeeETB,
        setupFeeApproved: Boolean(owner.setupFeeApproved),
        subscriptionPaymentApproved: Boolean(owner.subscriptionPaymentApproved),
        subscriptionPaidUntil: owner.subscriptionPaidUntil,
        paidQuartersCount: owner.paidQuartersCount ?? 0,
        billingHold: Boolean(owner.billingHold),
        billingStartedAt: owner.billingStartedAt,
        isIllustrationTenant: Boolean(owner.isIllustrationTenant),
        freeTrialEndsAt: owner.freeTrialEndsAt,
        billingNotes: owner.billingNotes,
        paymentChannel: owner.paymentChannel,
        paymentTransactionRef: owner.paymentTransactionRef,
        ownerUserName: owner.UserName,
        suspendedReason: account.suspendedReason,
        bannedReason: account.bannedReason,
        users,
        recentPayments: recentPayments.map((p) =>
          mapPaymentRow(p, account.hotelDisplayName),
        ),
        operationalSnapshot,
      };
    },

    apexTenantUsers: async (_, args, context) => {
      assertApex(context);
      return listTenantUsersForMonitoring(args);
    },

    apexAuditLogs: async (_, { limit, tinNumber }, context) => {
      assertApex(context);
      const where = {};
      if (tinNumber) where.targetTinNumber = String(tinNumber).trim();
      const rows = await prisma.apex_audit_log.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(limit ?? 50, 100),
        include: {
          apexMember: { select: { UserName: true, displayName: true } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        action: row.action,
        targetTinNumber: row.targetTinNumber,
        targetUserId: row.targetUserId,
        reason: row.reason,
        apexMemberName:
          row.apexMember?.displayName || row.apexMember?.UserName || null,
        createdAt: row.createdAt,
      }));
    },

    apexModuleChangeRequests: async (_, { status, limit }, context) => {
      assertApex(context);
      const statusFilter = status ? String(status).trim() : "pending";
      const where =
        statusFilter === "all" ? {} : { status: statusFilter };
      const rows = await prisma.tenant_module_change_request.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(limit ?? 50, 100),
        include: { tenantAccount: { select: { hotelDisplayName: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        tinNumber: row.tinNumber,
        hotelDisplayName: row.tenantAccount?.hotelDisplayName ?? row.tinNumber,
        status: row.status,
        requestedBySide: row.requestedBySide,
        requestNote: row.requestNote,
        requestedModules: row.requestedModules,
        createdAt: row.createdAt,
      }));
    },

    apexPendingPayments: async (_, { kind }, context) => {
      assertApex(context);
      const where = { status: "pending" };
      if (kind === "setup" || kind === "quarterly" || kind === "yearly") {
        where.paymentKind = kind;
      }
      const rows = await prisma.tenant_payment_submission.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        take: 100,
      });

      const tins = [...new Set(rows.map((r) => String(r.tinNumber).trim()))];
      const hotelByTin = await loadOwnerHotelNamesByTin(tins);
      return Promise.all(
        rows.map((row) =>
          mapPaymentRow(row, hotelByTin.get(String(row.tinNumber).trim()) ?? null),
        ),
      );
    },

    apexTenantPaymentHistory: async (_, { tinNumber, limit }, context) => {
      assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      const account = owner ? await ensureTenantAccount(tin, owner) : null;
      const rows = await prisma.tenant_payment_submission.findMany({
        where: { tinNumber: tin },
        orderBy: { submittedAt: "desc" },
        take: Math.min(limit ?? 50, 100),
      });
      const hotelName = account?.hotelDisplayName ?? owner?.HotelName ?? tin;
      return Promise.all(rows.map((row) => mapPaymentRow(row, hotelName)));
    },

    apexSignupPipeline: async (_, { limit }, context) => {
      assertApex(context);
      const owners = await listDistinctTenantOwners();
      const take = Math.min(limit ?? 50, 100);
      const pipeline = [];

      for (const owner of owners) {
        const sub = tenantBillingRowFromOwner(owner);
        if (computeSubscriptionPeriodStatus(sub) !== "setup_pending") continue;
        const tin =
          owner.tinNumber != null && String(owner.tinNumber).trim() !== ""
            ? String(owner.tinNumber).trim()
            : String(owner.HotelName).trim();
        const pending = await prisma.tenant_payment_submission.findFirst({
          where: { tinNumber: tin, paymentKind: "setup", status: "pending" },
          orderBy: { submittedAt: "desc" },
        });
        pipeline.push({
          tinNumber: tin,
          hotelDisplayName: owner.HotelName,
          businessType: owner.businessType,
          ownerUserName: owner.UserName,
          setupFeeETB: owner.setupFeeETB ?? 0,
          paymentTransactionRef: owner.paymentTransactionRef,
          paymentChannel: owner.paymentChannel,
          registeredAt: owner.createdAt,
          pendingSetupPaymentId: pending?.id ?? null,
        });
      }

      pipeline.sort(
        (a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime(),
      );
      return pipeline.slice(0, take);
    },

    apexPricingRules: async (_, { businessType }, context) => {
      assertApex(context);
      const rows = await listPricingRules(businessType);
      return rows.map(mapPricingRuleRow);
    },

    apexFeedbackTenantContext: async (_, { tinNumber }, context) => {
      return resolvers.Query.apexTenantDetail(_, { tinNumber }, context);
    },

    apexFeedbackDirectory: async (_, { search }, context) => {
      assertApex(context);
      const owners = await listDistinctTenantOwners();
      const q = String(search || "").trim().toLowerCase();

      const threads = await prisma.tenant_feedback_thread.findMany({
        orderBy: { updatedAt: "desc" },
      });
      const threadByTin = new Map(threads.map((t) => [t.tinNumber, t]));
      const threadIds = threads.map((t) => t.id);

      const [unreadByThread, messages] = await Promise.all([
        threadIds.length
          ? prisma.tenant_feedback_message.groupBy({
              by: ["threadId"],
              where: {
                threadId: { in: threadIds },
                senderSide: "tenant",
                readByApex: false,
              },
              _count: { _all: true },
            })
          : [],
        threadIds.length
          ? prisma.tenant_feedback_message.findMany({
              where: { threadId: { in: threadIds } },
              orderBy: { createdAt: "desc" },
            })
          : [],
      ]);

      const unreadMap = new Map(
        unreadByThread.map((r) => [r.threadId, r._count._all]),
      );
      const lastByThread = new Map();
      for (const msg of messages) {
        if (!lastByThread.has(msg.threadId)) lastByThread.set(msg.threadId, msg);
      }

      const tins = owners.map((owner) =>
        owner.tinNumber != null && String(owner.tinNumber).trim() !== ""
          ? String(owner.tinNumber).trim()
          : String(owner.HotelName).trim(),
      );
      const accountMap = await loadTenantAccountsByTin(tins);

      const rows = [];
      for (const owner of owners) {
        const tin =
          owner.tinNumber != null && String(owner.tinNumber).trim() !== ""
            ? String(owner.tinNumber).trim()
            : String(owner.HotelName).trim();
        const account = accountOrOwnerFallback(accountMap.get(tin), owner, tin);
        const displayName = account?.hotelDisplayName ?? owner.HotelName ?? tin;

        if (q) {
          const hay = `${displayName} ${tin} ${owner.UserName}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        const thread = threadByTin.get(tin);
        if (thread) {
          rows.push({
            tinNumber: tin,
            hotelDisplayName: thread.hotelDisplayName || displayName,
            threadId: thread.id,
            chatStatus: thread.status,
            unreadFromTenant: unreadMap.get(thread.id) ?? 0,
            updatedAt: thread.updatedAt,
            lastMessage: lastByThread.get(thread.id) ?? null,
          });
        } else {
          rows.push({
            tinNumber: tin,
            hotelDisplayName: displayName,
            threadId: null,
            chatStatus: "no_thread",
            unreadFromTenant: 0,
            updatedAt: owner.createdAt,
            lastMessage: null,
          });
        }
      }

      rows.sort((a, b) => {
        if (b.unreadFromTenant !== a.unreadFromTenant) {
          return b.unreadFromTenant - a.unreadFromTenant;
        }
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        if (bt !== at) return bt - at;
        return a.hotelDisplayName.localeCompare(b.hotelDisplayName);
      });

      return rows;
    },

    apexFeedbackThreads: async (_, { limit }, context) => {
      assertApex(context);
      const threads = await prisma.tenant_feedback_thread.findMany({
        orderBy: { updatedAt: "desc" },
        take: limit ?? 500,
      });

      const threadIds = threads.map((t) => t.id);
      const [unreadByThread, messages] = await Promise.all([
        prisma.tenant_feedback_message.groupBy({
          by: ["threadId"],
          where: {
            threadId: { in: threadIds },
            senderSide: "tenant",
            readByApex: false,
          },
          _count: { _all: true },
        }),
        threadIds.length
          ? prisma.tenant_feedback_message.findMany({
              where: { threadId: { in: threadIds } },
              orderBy: { createdAt: "desc" },
            })
          : [],
      ]);

      const unreadMap = new Map(
        unreadByThread.map((r) => [r.threadId, r._count._all]),
      );
      const lastByThread = new Map();
      for (const msg of messages) {
        if (!lastByThread.has(msg.threadId)) lastByThread.set(msg.threadId, msg);
      }

      return threads.map((thread) => ({
        ...thread,
        unreadFromTenant: unreadMap.get(thread.id) ?? 0,
        lastMessage: lastByThread.get(thread.id) ?? null,
      }));
    },

    apexFeedbackThread: async (_, { threadId }, context) => {
      assertApex(context);
      const thread = await prisma.tenant_feedback_thread.findUnique({
        where: { id: threadId },
      });
      if (!thread) throw new Error("Thread not found");

      const messages = await prisma.tenant_feedback_message.findMany({
        where: { threadId },
        orderBy: { createdAt: "asc" },
      });

      await prisma.tenant_feedback_message.updateMany({
        where: { threadId, senderSide: "tenant" },
        data: { readByApex: true },
      });

      return { ...thread, messages };
    },
  },

  Mutation: {
    apexLogin: async (_, { UserName, Password }) => {
      const name = String(UserName).trim();
      const member = await prisma.apex_team_member.findUnique({
        where: { UserName: name },
      });
      if (!member || !member.isActive) {
        throw new Error("Invalid username or password");
      }
      const valid = await bcrypt.compare(Password, member.Password);
      if (!valid) throw new Error("Invalid username or password");

      const token = signApexToken(member);
      return {
        token,
        member: {
          id: member.id,
          UserName: member.UserName,
          displayName: member.displayName,
          role: member.role,
        },
      };
    },

    approveTenantSetupPayment: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const now = new Date();
      const createdAt = owner.createdAt ? new Date(owner.createdAt) : now;
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
      await writeApexAudit(apex.apexMemberId, "approve_setup", {
        targetTinNumber: tin,
      });
      return true;
    },

    rejectTenantSetupPayment: async (_, { tinNumber, reason }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      const note = String(reason || "").trim();
      if (!note) throw new Error("Rejection reason is required");

      const now = new Date();
      const pending = await prisma.tenant_payment_submission.findFirst({
        where: { tinNumber: tin, paymentKind: "setup", status: "pending" },
        orderBy: { submittedAt: "desc" },
      });
      if (pending) {
        await prisma.tenant_payment_submission.update({
          where: { id: pending.id },
          data: {
            status: "rejected",
            rejectedAt: now,
            rejectedByApexMemberId: apex.apexMemberId,
            rejectionReason: note,
          },
        });
      }

      await writeApexAudit(apex.apexMemberId, "reject_setup", {
        targetTinNumber: tin,
        reason: note,
        payload: { submissionId: pending?.id ?? null },
      });
      return true;
    },

    rejectTenantPayment: async (_, { submissionId, reason }, context) => {
      const apex = assertApex(context);
      const note = String(reason || "").trim();
      if (!note) throw new Error("Rejection reason is required");
      const now = new Date();
      const row = await prisma.tenant_payment_submission.update({
        where: { id: submissionId },
        data: {
          status: "rejected",
          rejectedAt: now,
          rejectedByApexMemberId: apex.apexMemberId,
          rejectionReason: note,
        },
      });
      await writeApexAudit(apex.apexMemberId, "reject_payment", {
        targetTinNumber: row.tinNumber,
        payload: { submissionId },
        reason,
      });
      return true;
    },

    approveTenantQuarterPayment: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      if (!quarterlyFeeApplies(owner.quarterlyFeeETB ?? 0)) {
        throw new Error("No subscription billing for this tenant");
      }
      if (subscriptionRenewalPaymentKind(owner.businessType) !== "quarterly") {
        throw new Error("This property uses yearly billing — use yearly payment approval");
      }

      const nextPeriods = (owner.paidQuartersCount ?? 0) + 1;
      const paidUntil = computePaidUntilForOwner(owner, nextPeriods);
      const now = new Date();

      const pending = await prisma.tenant_payment_submission.findFirst({
        where: { tinNumber: tin, paymentKind: "quarterly", status: "pending" },
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
          subscriptionPaymentApproved: true,
          paidQuartersCount: nextPeriods,
          subscriptionPaidUntil: paidUntil,
        },
      });

      await writeApexAudit(apex.apexMemberId, "approve_quarterly", {
        targetTinNumber: tin,
      });
      return true;
    },

    approveTenantYearlyPayment: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      if (!quarterlyFeeApplies(owner.quarterlyFeeETB ?? 0)) {
        throw new Error("No subscription billing for this tenant");
      }
      if (subscriptionRenewalPaymentKind(owner.businessType) !== "yearly") {
        throw new Error("This property uses quarterly billing — use quarterly payment approval");
      }

      const nextPeriods = (owner.paidQuartersCount ?? 0) + 1;
      const paidUntil = computePaidUntilForOwner(owner, nextPeriods);
      const now = new Date();

      const pending = await prisma.tenant_payment_submission.findFirst({
        where: { tinNumber: tin, paymentKind: "yearly", status: "pending" },
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
          subscriptionPaymentApproved: true,
          paidQuartersCount: nextPeriods,
          subscriptionPaidUntil: paidUntil,
        },
      });

      await writeApexAudit(apex.apexMemberId, "approve_yearly", {
        targetTinNumber: tin,
      });
      return true;
    },

    releaseTenantBillingHold: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      if (owner.isIllustrationTenant) {
        throw new Error("Illustration tenants do not use billing hold");
      }
      if (!owner.billingHold) throw new Error("Not on billing hold");

      const now = new Date();
      const billingApplies = quarterlyFeeApplies(owner.quarterlyFeeETB ?? 0);
      const paidUntil = billingApplies
        ? computeSubscriptionPaidUntil(now, 1, owner.businessType ?? null)
        : null;

      await prisma.user.update({
        where: { id: owner.id },
        data: {
          billingHold: false,
          billingStartedAt: now,
          paidQuartersCount: billingApplies ? 1 : 0,
          subscriptionPaidUntil: paidUntil,
          subscriptionPaymentApproved:
            billingApplies && Boolean(owner.setupFeeApproved),
        },
      });

      await writeApexAudit(apex.apexMemberId, "release_billing_hold", {
        targetTinNumber: tin,
      });
      return true;
    },

    suspendTenant: async (_, { tinNumber, reason }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      const now = new Date();
      await ensureTenantAccount(tin, owner);
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: {
          accountStatus: "suspended",
          suspendedAt: now,
          suspendedReason: String(reason || "").trim() || null,
          suspendedByApexMemberId: apex.apexMemberId,
          bannedAt: null,
          bannedReason: null,
          bannedByApexMemberId: null,
        },
      });
      await writeApexAudit(apex.apexMemberId, "suspend_tenant", {
        targetTinNumber: tin,
        reason,
      });
      return true;
    },

    unsuspendTenant: async (_, { tinNumber, reason }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: {
          accountStatus: "active",
          suspendedAt: null,
          suspendedReason: null,
          suspendedByApexMemberId: null,
        },
      });
      await writeApexAudit(apex.apexMemberId, "unsuspend_tenant", {
        targetTinNumber: tin,
        reason,
      });
      return true;
    },

    banTenant: async (_, { tinNumber, reason }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      const now = new Date();
      await ensureTenantAccount(tin, owner);
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: {
          accountStatus: "banned",
          bannedAt: now,
          bannedReason: String(reason || "").trim() || null,
          bannedByApexMemberId: apex.apexMemberId,
        },
      });
      await writeApexAudit(apex.apexMemberId, "ban_tenant", {
        targetTinNumber: tin,
        reason,
      });
      return true;
    },

    unbanTenant: async (_, { tinNumber, reason }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: {
          accountStatus: "active",
          bannedAt: null,
          bannedReason: null,
          bannedByApexMemberId: null,
        },
      });
      await writeApexAudit(apex.apexMemberId, "unban_tenant", {
        targetTinNumber: tin,
        reason,
      });
      return true;
    },

    setUserLoginDisabled: async (_, { userId, disabled, reason }, context) => {
      const apex = assertApex(context);
      const now = new Date();
      await prisma.user.update({
        where: { id: userId },
        data: disabled
          ? {
              loginDisabled: true,
              loginDisabledReason: reason ? String(reason).trim() : null,
              loginDisabledAt: now,
              loginDisabledByApexMemberId: apex.apexMemberId,
            }
          : {
              loginDisabled: false,
              loginDisabledReason: null,
              loginDisabledAt: null,
              loginDisabledByApexMemberId: null,
            },
      });
      await writeApexAudit(apex.apexMemberId, disabled ? "disable_user_login" : "enable_user_login", {
        targetUserId: userId,
        reason,
      });
      return true;
    },

    updateTenantBilling: async (_, args, context) => {
      const apex = assertApex(context);
      const tin = String(args.tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const data = {};
      if (args.setupFeeETB != null) data.setupFeeETB = Number(args.setupFeeETB);
      if (args.quarterlyFeeETB != null) data.quarterlyFeeETB = Number(args.quarterlyFeeETB);
      if (args.setupFeeETB != null || args.quarterlyFeeETB != null) {
        data.feesManuallySet = true;
        data.pricingRuleId = null;
      }
      if (args.billingNotes !== undefined) data.billingNotes = args.billingNotes;
      if (args.isIllustrationTenant != null) {
        data.isIllustrationTenant = Boolean(args.isIllustrationTenant);
      }
      if (args.billingHold != null) data.billingHold = Boolean(args.billingHold);
      if (args.freeTrialEndsAt !== undefined) {
        data.freeTrialEndsAt = args.freeTrialEndsAt
          ? new Date(args.freeTrialEndsAt)
          : null;
      }

      await prisma.user.update({ where: { id: owner.id }, data });
      await writeApexAudit(apex.apexMemberId, "update_tenant_billing", {
        targetTinNumber: tin,
        payload: data,
      });
      return true;
    },

    applySuggestedTenantFees: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const list = parseModulesJson(owner.modules);
      const feeData = await catalogFeePatch(owner.businessType, list);

      await prisma.user.update({ where: { id: owner.id }, data: feeData });
      await writeApexAudit(apex.apexMemberId, "apply_catalog_fees", {
        targetTinNumber: tin,
        payload: feeData,
      });
      return true;
    },

    upsertPricingRule: async (_, args, context) => {
      const apex = assertApex(context);
      const bt = normalizePricingBusinessType(args.businessType);
      const list = parseModulesJson(args.modules);
      const modulesKey = buildModulesKey(list);
      const payload = {
        businessType: bt,
        modulesKey,
        modules: list,
        setupFeeETB: Number(args.setupFeeETB),
        quarterlyFeeETB: Number(args.quarterlyFeeETB),
        description: args.description != null ? String(args.description).trim() : null,
        isActive: args.isActive != null ? Boolean(args.isActive) : true,
        sortOrder: args.sortOrder != null ? Number(args.sortOrder) : 0,
      };

      let row;
      if (args.id != null) {
        row = await prisma.subscription_pricing_rule.update({
          where: { id: Number(args.id) },
          data: payload,
        });
      } else {
        row = await prisma.subscription_pricing_rule.upsert({
          where: { businessType_modulesKey: { businessType: bt, modulesKey } },
          create: payload,
          update: payload,
        });
      }

      await writeApexAudit(apex.apexMemberId, "upsert_pricing_rule", {
        payload: { id: row.id, businessType: bt, modulesKey },
      });
      return mapPricingRuleRow(row);
    },

    setPricingRuleActive: async (_, { id, isActive }, context) => {
      const apex = assertApex(context);
      await prisma.subscription_pricing_rule.update({
        where: { id: Number(id) },
        data: { isActive: Boolean(isActive) },
      });
      await writeApexAudit(apex.apexMemberId, "set_pricing_rule_active", {
        payload: { id, isActive },
      });
      return true;
    },

    updateTenantModules: async (_, { tinNumber, modules, recalcFees }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const list = parseModulesJson(modules);
      const shouldRecalc =
        recalcFees != null ? Boolean(recalcFees) : !owner.feesManuallySet;
      const feeData = shouldRecalc
        ? await catalogFeePatch(owner.businessType, list)
        : {};

      await prisma.user.update({
        where: { id: owner.id },
        data: {
          modules: list,
          ...feeData,
        },
      });
      await syncOwnerModulesToAllUsers(tin, list);
      await ensureTenantAccount(tin, owner);
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: { modules: list },
      });

      const fees = await resolveSignupPricing(owner.businessType, list);
      await writeApexAudit(apex.apexMemberId, "update_tenant_modules", {
        targetTinNumber: tin,
        payload: { modules: list, fees, recalcFees: shouldRecalc },
      });
      return true;
    },

    syncTenantStaffModules: async (_, { tinNumber }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");
      const list = parseModulesJson(owner.modules);
      await syncOwnerModulesToAllUsers(tin, list);
      await writeApexAudit(apex.apexMemberId, "sync_staff_modules", {
        targetTinNumber: tin,
        payload: { modules: list },
      });
      return true;
    },

    approveModuleChangeRequest: async (_, { requestId, reviewNote }, context) => {
      const apex = assertApex(context);
      const row = await prisma.tenant_module_change_request.findUnique({
        where: { id: requestId },
      });
      if (!row || row.status !== "pending") {
        throw new Error("Module change request not found or not pending");
      }
      const tin = String(row.tinNumber).trim();
      const owner = await findTenantOwner(tin);
      if (!owner) throw new Error("Tenant not found");

      const list = parseModulesJson(row.requestedModules);
      const fees = await resolveSignupPricing(owner.businessType, list);
      const feeData = owner.feesManuallySet
        ? {}
        : {
            setupFeeETB: fees.setupFeeETB,
            quarterlyFeeETB: fees.quarterlyFeeETB,
            pricingRuleId: fees.pricingRuleId,
            feesManuallySet: false,
          };
      const now = new Date();

      await prisma.user.update({
        where: { id: owner.id },
        data: {
          modules: list,
          ...feeData,
        },
      });
      await syncOwnerModulesToAllUsers(tin, list);
      await ensureTenantAccount(tin, owner);
      await prisma.tenant_account.update({
        where: { tinNumber: tin },
        data: { modules: list },
      });
      await prisma.tenant_module_change_request.update({
        where: { id: requestId },
        data: {
          status: "approved",
          reviewedByApexMemberId: apex.apexMemberId,
          reviewedAt: now,
          reviewNote: reviewNote ? String(reviewNote).trim() : null,
          setupFeeETB: fees.setupFeeETB,
          quarterlyFeeETB: fees.quarterlyFeeETB,
        },
      });

      await writeApexAudit(apex.apexMemberId, "approve_module_change", {
        targetTinNumber: tin,
        payload: { requestId, modules: list, fees },
        reason: reviewNote,
      });
      return true;
    },

    rejectModuleChangeRequest: async (_, { requestId, reviewNote }, context) => {
      const apex = assertApex(context);
      const row = await prisma.tenant_module_change_request.findUnique({
        where: { id: requestId },
      });
      if (!row || row.status !== "pending") {
        throw new Error("Module change request not found or not pending");
      }
      await prisma.tenant_module_change_request.update({
        where: { id: requestId },
        data: {
          status: "rejected",
          reviewedByApexMemberId: apex.apexMemberId,
          reviewedAt: new Date(),
          reviewNote: reviewNote ? String(reviewNote).trim() : null,
        },
      });
      await writeApexAudit(apex.apexMemberId, "reject_module_change", {
        targetTinNumber: row.tinNumber,
        payload: { requestId },
        reason: reviewNote,
      });
      return true;
    },

    startApexChatWithTenant: async (_, { tinNumber, body }, context) => {
      const apex = assertApex(context);
      const tin = String(tinNumber || "").trim();
      if (!tin) throw new Error("TIN required");
      const text = String(body || "").trim();
      if (!text) throw new Error("Opening message is required");

      let thread = await getOrCreateFeedbackThreadForTin(tin);

      if (thread.status === "closed") {
        thread = await prisma.tenant_feedback_thread.update({
          where: { id: thread.id },
          data: {
            status: "open",
            closedAt: null,
            closedByApexMemberId: null,
            updatedAt: new Date(),
          },
        });
      }

      const member = await prisma.apex_team_member.findUnique({
        where: { id: apex.apexMemberId },
      });
      await prisma.tenant_feedback_message.create({
        data: {
          threadId: thread.id,
          senderSide: "apex",
          apexMemberId: apex.apexMemberId,
          apexDisplayName: member?.displayName || member?.UserName || "Apex",
          body: text,
          readByApex: true,
          readByTenant: false,
        },
      });
      thread = await prisma.tenant_feedback_thread.update({
        where: { id: thread.id },
        data: { updatedAt: new Date(), status: "open" },
      });

      const messages = await prisma.tenant_feedback_message.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "asc" },
      });

      await writeApexAudit(apex.apexMemberId, "start_apex_chat", {
        targetTinNumber: tin,
        payload: { threadId: thread.id, hasOpeningMessage: Boolean(text) },
      });

      return { ...thread, messages };
    },

    sendApexFeedbackMessage: async (_, { threadId, body, imageUrl }, context) => {
      const apex = assertApex(context);
      const text = String(body || "").trim();
      const image = String(imageUrl || "").trim();
      if (!text && !image) throw new Error("Message or image required");

      const member = await prisma.apex_team_member.findUnique({
        where: { id: apex.apexMemberId },
      });

      const msg = await prisma.tenant_feedback_message.create({
        data: {
          threadId,
          senderSide: "apex",
          apexMemberId: apex.apexMemberId,
          apexDisplayName: member?.displayName || member?.UserName || "Apex Team",
          body: text,
          imageUrl: image || null,
          readByApex: true,
          readByTenant: false,
        },
      });

      await prisma.tenant_feedback_thread.update({
        where: { id: threadId },
        data: { updatedAt: new Date(), status: "open" },
      });

      return msg;
    },

    markApexFeedbackRead: async (_, { threadId }, context) => {
      assertApex(context);
      await prisma.tenant_feedback_message.updateMany({
        where: { threadId, senderSide: "tenant" },
        data: { readByApex: true },
      });
      return true;
    },

    closeFeedbackThread: async (_, { threadId, reason }, context) => {
      const apex = assertApex(context);
      await prisma.tenant_feedback_thread.update({
        where: { id: threadId },
        data: {
          status: "closed",
          closedAt: new Date(),
          closedByApexMemberId: apex.apexMemberId,
        },
      });
      await writeApexAudit(apex.apexMemberId, "close_feedback_thread", {
        payload: { threadId },
        reason,
      });
      return true;
    },
  },
};
