import { prisma } from "./prisma.js";

export async function writeApexAudit(apexMemberId, action, opts = {}) {
  try {
    await prisma.apex_audit_log.create({
      data: {
        apexMemberId: apexMemberId ?? null,
        action,
        targetTinNumber: opts.targetTinNumber ?? null,
        targetUserId: opts.targetUserId ?? null,
        payload: opts.payload ?? null,
        reason: opts.reason ?? null,
      },
    });
  } catch (e) {
    console.error("[apex_audit_log]", action, e?.message);
  }
}
