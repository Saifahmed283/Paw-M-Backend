import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "auth-middleware" });

const ROLE_HIERARCHY = { staff: 0, payroll: 1, admin: 2 };

function timingSafeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function isStateChanging(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

export function authenticateUser(req, res, next) {
  // Accept the staff JWT either from an Authorization: Bearer header (used when
  // the frontend and API are cross-origin and cookies are unreliable) or from
  // the same-origin session cookie.
  const authHeader = req.headers.authorization;
  let token = null;
  let fromCookie = false;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else {
    token = req.cookies?.[config.cookieName];
    fromCookie = true;
  }
  if (!token) {
    return res.status(401).json({ error: "Unauthorized — no session" });
  }

  // Cookie-sourced state-changing requests must prove they were not issued
  // cross-site: the double-submit CSRF cookie must match the X-CSRF-Token
  // header (fetch cannot read another origin's cookie, so an attacker cannot
  // forge it). Bearer-header sessions are not cookie-bound and skip this check.
  if (fromCookie && isStateChanging(req)) {
    const csrfHeader = String(req.headers["x-csrf-token"] ?? "");
    if (!timingSafeEqualStrings(csrfHeader, req.cookies?.[config.csrfCookieName])) {
      return res.status(403).json({ error: "CSRF token mismatch" });
    }
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired" });
    }
    return res.status(401).json({ error: "Invalid session" });
  }

  prisma.adminUser
    .findUnique({ where: { id: decoded.id }, select: { id: true, username: true, role: true } })
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }
      req.user = { id: user.id, username: user.username, role: user.role };
      next();
    })
    .catch((err) => {
      log.error({ err }, "auth middleware db error");
      return res.status(500).json({ error: "Internal server error" });
    });
}

export function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
    const requiredLevel = ROLE_HIERARCHY[minRole] ?? 999;
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: "Forbidden — insufficient permissions" });
    }
    next();
  };
}

export const requireAdmin = requireRole("admin");
export const requireStaff = requireRole("staff");

export const requirePayrollOrAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (req.user.role !== "admin" && req.user.role !== "payroll") {
    return res.status(403).json({ error: "Forbidden — admin or payroll required" });
  }
  next();
};

export function authenticateClient(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized — no client session" });
  }
  const token = authHeader.slice(7);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  prisma.clientSession
    .findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      select: { clientId: true },
    })
    .then((session) => {
      if (!session) {
        return res.status(401).json({ error: "Invalid or expired client session" });
      }
      return prisma.clientAccount.findUnique({
        where: { id: session.clientId },
        select: { id: true, email: true, fullName: true, suspended: true },
      });
    })
    .then((client) => {
      if (!client) {
        return res.status(401).json({ error: "Client account not found" });
      }
      if (client.suspended) {
        return res.status(403).json({ error: "Account suspended — contact the clinic" });
      }
      req.client = client;
      next();
    })
    .catch((err) => {
      log.error({ err }, "client auth middleware error");
      return res.status(500).json({ error: "Internal server error" });
    });
}

/**
 * Counter / POS middleware: accepts either a store client's bearer token or an
 * authenticated staff/admin session cookie. Used where a sale may legitimately
 * be created by a cashier at the counter (no client logged in) as well as by a
 * store customer during online checkout.
 */
export function authenticateClientOrStaff(req, res, next) {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    const bearer = req.headers.authorization.slice(7);
    // Staff tokens are JWTs (contain dots); client tokens are opaque hex. Route
    // each to its own verifier so a cashier's staff session also works as a
    // Bearer token (cookie fallback below stays for same-origin deployments).
    if (bearer.includes(".")) {
      return authenticateUser(req, res, next);
    }
    return authenticateClient(req, res, next);
  }
  if (req.cookies?.[config.cookieName]) {
    return authenticateUser(req, res, next);
  }
  return res.status(401).json({ error: "Unauthorized — sign in to continue" });
}
