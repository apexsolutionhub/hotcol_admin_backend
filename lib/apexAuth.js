import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_Secret || process.env.JWT_SECRET || "apex-dev-secret-change-me";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN?.trim() || "7d";

export function signApexToken(member) {
  return jwt.sign(
    {
      actorType: "apex",
      apexMemberId: member.id,
      UserName: member.UserName,
      role: member.role,
      displayName: member.displayName,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

export function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.actorType !== "apex") return null;
    return payload;
  } catch {
    return null;
  }
}

export function assertApex(context) {
  if (!context.apex) throw new Error("Not authenticated");
  return context.apex;
}

export function assertApexRole(context, allowed) {
  const apex = assertApex(context);
  if (!allowed.includes(apex.role)) {
    throw new Error("Not authorized for this action");
  }
  return apex;
}
