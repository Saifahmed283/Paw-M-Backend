import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "auth-middleware" });

const ROLE_HIERARCHY = { staff: 0, payroll: 1, admin: 2 };

export function authenticateUser(req, res, next) {
  const token = req.cookies?.[config.cookieName];
  if (!token) {
    return res.status(401).json({ error: "Unauthorized — no session" });
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
        select: { id: true, email: true, fullName: true },
      });
    })
    .then((client) => {
      if (!client) {
        return res.status(401).json({ error: "Client account not found" });
      }
      req.client = client;
      next();
    })
    .catch((err) => {
      log.error({ err }, "client auth middleware error");
      return res.status(500).json({ error: "Internal server error" });
    });
}
