import {
  computeQuarterEndFromCreatedAt,
  daysBetweenCalendar,
  SUBSCRIPTION_QUARTER_DAYS,
} from "./subscriptionPricing.js";
import {
  computeSubscriptionPaidUntil,
  subscriptionRenewalPaymentKind,
} from "./subscriptionBillingPeriod.js";

export { daysBetweenCalendar, SUBSCRIPTION_QUARTER_DAYS, computeQuarterEndFromCreatedAt };
export {
  computeSubscriptionPaidUntil,
  subscriptionRenewalPaymentKind,
} from "./subscriptionBillingPeriod.js";

export function isFreeTrialActive(sub, now = new Date()) {
  if (!sub.freeTrialEndsAt) return false;
  const end = new Date(sub.freeTrialEndsAt);
  return !Number.isNaN(end.getTime()) && now.getTime() < end.getTime();
}

export function resolveBillingAnchor(sub) {
  if (sub.billingHold) return null;
  if (sub.billingStartedAt) {
    const d = new Date(sub.billingStartedAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (sub.createdAt) {
    const d = new Date(sub.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export function selfSignupAwaitingSetup(sub, pendingSetupSubmission = false) {
  if (sub.setupFeeApproved) return false;
  const setupFeeETB = Number(sub.setupFeeETB ?? 0);
  if (setupFeeETB <= 0) return false;
  if (pendingSetupSubmission) return true;
  const ref =
    sub.paymentTransactionRef != null
      ? String(sub.paymentTransactionRef).trim()
      : "";
  return ref.length >= 4;
}

export function computeSubscriptionPeriodStatus(sub, now = new Date()) {
  if (sub.isIllustrationTenant) return "exempt";
  if (sub.billingHold) return "on_hold";
  const quarterlyFeeETB = sub.quarterlyFeeETB ?? 0;
  if (Number(quarterlyFeeETB) <= 0) return "exempt";
  if (selfSignupAwaitingSetup(sub)) return "setup_pending";
  if (isFreeTrialActive(sub, now)) return "trial";
  const anchor = resolveBillingAnchor(sub);
  if (!anchor) return "on_hold";
  const paidUntil = sub.subscriptionPaidUntil ? new Date(sub.subscriptionPaidUntil) : null;
  if (!paidUntil || Number.isNaN(paidUntil.getTime())) return "active";
  const daysUntilEnd = daysBetweenCalendar(now, paidUntil);
  if (daysUntilEnd > 10) return "active";
  if (daysUntilEnd >= 0) return "warning";
  const daysPast = -daysUntilEnd;
  if (daysPast >= 1 && daysPast < 10) return "grace";
  return "expired";
}

export function tenantBillingRowFromOwner(row) {
  return {
    modules: row.modules,
    setupFeeETB: row.setupFeeETB ?? 0,
    quarterlyFeeETB: row.quarterlyFeeETB ?? 0,
    setupFeeApproved: Boolean(row.setupFeeApproved),
    createdAt: row.createdAt ?? null,
    billingStartedAt: row.billingStartedAt ?? null,
    billingHold: Boolean(row.billingHold),
    isIllustrationTenant: Boolean(row.isIllustrationTenant),
    freeTrialEndsAt: row.freeTrialEndsAt ?? null,
    billingNotes: row.billingNotes ?? null,
    subscriptionPaidUntil: row.subscriptionPaidUntil ?? null,
    subscriptionPaymentApproved: Boolean(row.subscriptionPaymentApproved),
    paidQuartersCount: row.paidQuartersCount ?? 0,
    paymentTransactionRef: row.paymentTransactionRef ?? null,
  };
}

function quarterlyFeeApplies(q) {
  return Number(q) > 0;
}

export function computeQuarterEndFromRegistration(createdAt, paidQuartersCount) {
  return computeQuarterEndFromCreatedAt(createdAt, paidQuartersCount);
}

export function computePaidUntilForOwner(owner, paidPeriodsCount) {
  const sub = tenantBillingRowFromOwner(owner);
  const anchor = resolveBillingAnchor(sub);
  if (!anchor) return null;
  return computeSubscriptionPaidUntil(
    anchor,
    paidPeriodsCount,
    owner.businessType ?? null,
  );
}

export { quarterlyFeeApplies };
