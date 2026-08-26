import jwt from "jsonwebtoken";
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
