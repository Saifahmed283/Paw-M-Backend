import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { validate } from "../middleware/validate.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import {
  loginSchema,
  registerSchema,
  changeCredentialsSchema,
  createAccountSchema,
  updateAccountRoleSchema,
  updateAccountSchema,
  accountIdParamSchema,
} from "../schemas/auth.js";
import { sendMail, buildPasswordResetEmail } from "../lib/email.js";

const router = Router();
const log = logger.child({ module: "routes/auth" });

const passwordResets = new Map();

const MIN_USERNAME = 3;
const MIN_PASSWORD = 6;
const BCRYPT_ROUNDS = 12;

function hashPassword(password, salt) {
  const hashed = bcrypt.hashSync(password, salt);
  if (typeof hashed === "string") return hashed;
  return Buffer.from(hashed).toString("hex");
}

function constantTimeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    const len = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(len, 0);
    const paddedB = Buffer.alloc(len, 0);
    bufA.copy(paddedA);
    bufB.copy(paddedB);
    try {
      return timingSafeEqual(paddedA, paddedB);
    } catch {
      return false;
    }
  }
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function parseExpiresInToMs(expiresIn) {
  const match = expiresIn.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 8 * 60 * 60 * 1000;
  const val = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return val * 1000;
    case "m": return val * 60 * 1000;
    case "h": return val * 60 * 60 * 1000;
    case "d": return val * 24 * 60 * 60 * 1000;
    default: return 8 * 60 * 60 * 1000;
  }
}

function setSessionCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? "none" : "lax",
    maxAge: parseExpiresInToMs(config.jwtExpiresIn),
    path: "/",
  });
  // Double-submit CSRF token: readable by same-origin JS (so it can be echoed
  // in X-CSRF-Token), but unreadable cross-site, which blocks cookie-auth CSRF.
  res.cookie(config.csrfCookieName, randomBytes(32).toString("hex"), {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: config.isProduction ? "none" : "lax",
    maxAge: parseExpiresInToMs(config.jwtExpiresIn),
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: config.isProduction ? "none" : "lax",
    path: "/",
  });
  res.clearCookie(config.csrfCookieName, {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: config.isProduction ? "none" : "lax",
    path: "/",
  });
}

router.get("/config", async (_req, res) => {
  try {
    const user = await prisma.adminUser.findFirst();
    res.json({ configured: Boolean(user) });
  } catch {
    res.status(500).json({ error: "Failed to check auth config" });
  }
});

router.post("/register", validate(registerSchema), async (req, res) => {
  const { username, password } = req.validated.body;
  const name = username.trim().toLowerCase();
  try {
    const existing = await prisma.adminUser.findFirst();
    if (existing) return res.status(409).json({ error: "Staff account already exists." });
    const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
    const hash = hashPassword(password, salt);
    const user = await prisma.adminUser.create({
      data: { username: name, salt, hash, role: "staff", isActive: true },
    });
    const token = signToken(user);
    setSessionCookie(res, token);
    logAudit("register", "", `Staff account created: ${name}`);
    res.json({ configured: true, role: user.role, token });
  } catch (e) {
    log.error({ err: e }, "register failed");
    res.status(500).json({ error: "Failed to create staff account" });
  }
});

router.post("/login", validate(loginSchema), async (req, res) => {
  const { username, password } = req.validated.body;
  const name = username.trim().toLowerCase();
  try {
    const user = await prisma.adminUser.findUnique({ where: { username: name } });
    if (!user) return res.json({ ok: false });
    const hash = hashPassword(password, user.salt);
    const ok = constantTimeCompare(hash, user.hash);
    if (!ok) {
      return res.json({ ok: false, role: undefined });
    }
    if (user.isActive === false) {
      return res.status(403).json({ error: "Account suspended" });
    }
    const token = signToken(user);
    setSessionCookie(res, token);
    logAudit("login", "", `Staff sign-in: ${name} [${user.role}]`);
    res.json({ ok: true, role: user.role, token });
  } catch (e) {
    log.error({ err: e }, "login failed");
    res.status(500).json({ error: "Failed to verify credentials" });
  }
});

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- Account management (admin only) ----
const ACCOUNT_SELECT = { id: true, username: true, role: true, isActive: true, createdAt: true };

async function countActiveAdmins(excludeId) {
  return prisma.adminUser.count({
    where: { role: "admin", isActive: true, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
  });
}

router.get("/accounts", authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const accounts = await prisma.adminUser.findMany({
      select: ACCOUNT_SELECT,
      orderBy: { id: "asc" },
    });
    res.json({ accounts, total: accounts.length });
  } catch (e) {
    log.error({ err: e }, "failed to list accounts");
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

router.post("/accounts", authenticateUser, requireAdmin, validate(createAccountSchema), async (req, res) => {
  const { username, password, role } = req.validated.body;
  try {
    const exists = await prisma.adminUser.findUnique({ where: { username } });
    if (exists) return res.status(409).json({ error: `Username "${username}" already exists.` });
    const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
    const hash = hashPassword(password, salt);
    const user = await prisma.adminUser.create({
      data: { username, salt, hash, role, isActive: true },
      select: ACCOUNT_SELECT,
    });
    logAudit(
      "create_account",
      String(user.id),
      `Account created: ${user.username} (${user.role}) by ${req.user.username}`,
    );
    res.status(201).json(user);
  } catch (e) {
    log.error({ err: e }, "failed to create account");
    res.status(500).json({ error: "Failed to create account" });
  }
});

router.patch(
  "/accounts/:id/role",
  authenticateUser,
  requireAdmin,
  validate(updateAccountRoleSchema),
  async (req, res) => {
    const { id } = req.validated.params;
    const { role } = req.validated.body;
    try {
      const target = await prisma.adminUser.findUnique({ where: { id }, select: ACCOUNT_SELECT });
      if (!target) return res.status(404).json({ error: "Account not found" });
      if (target.role === "admin" && role !== "admin" && target.isActive) {
        const remaining = await countActiveAdmins(id);
        if (remaining < 1) {
          return res.status(400).json({ error: "Cannot demote the last active admin account." });
        }
      }
      const user = await prisma.adminUser.update({
        where: { id },
        data: { role },
        select: ACCOUNT_SELECT,
      });
      logAudit(
        "update_account_role",
        String(user.id),
        `Role changed ${target.username}: ${target.role} -> ${role} by ${req.user.username}`,
      );
      res.json(user);
    } catch (e) {
      log.error({ err: e }, "failed to update account role");
      res.status(500).json({ error: "Failed to update account role" });
    }
  },
);

router.patch(
  "/accounts/:id",
  authenticateUser,
  requireAdmin,
  validate(updateAccountSchema),
  async (req, res) => {
    const { id } = req.validated.params;
    const { username, password, role, isActive } = req.validated.body;
    try {
      const target = await prisma.adminUser.findUnique({ where: { id }, select: ACCOUNT_SELECT });
      if (!target) return res.status(404).json({ error: "Account not found" });

      const nextActive = isActive ?? target.isActive;
      const nextRole = role ?? target.role;
      const removingAdminPower = target.role === "admin" && target.isActive && !(nextRole === "admin" && nextActive);
      if (removingAdminPower) {
        const remaining = await countActiveAdmins(id);
        if (remaining < 1) {
          return res.status(400).json({ error: "Cannot remove or suspend the last active admin account." });
        }
      }

      if (username && username !== target.username) {
        const taken = await prisma.adminUser.findUnique({ where: { username } });
        if (taken) return res.status(409).json({ error: `Username "${username}" already exists.` });
      }

      const data = {};
      if (username !== undefined) data.username = username;
      if (role !== undefined) data.role = role;
      if (isActive !== undefined) data.isActive = isActive;
      if (password !== undefined) {
        const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
        data.salt = salt;
        data.hash = hashPassword(password, salt);
      }

      const user = await prisma.adminUser.update({ where: { id }, data, select: ACCOUNT_SELECT });
      const parts = [];
      if (username !== undefined && username !== target.username) parts.push(`username -> ${username}`);
      if (role !== undefined && role !== target.role) parts.push(`role ${target.role} -> ${role}`);
      if (isActive !== undefined && isActive !== target.isActive) parts.push(isActive ? "activated" : "suspended");
      if (password !== undefined) parts.push("password reset");
      logAudit("update_account", String(user.id), `Account ${target.username}: ${parts.join(", ") || "no changes"} by ${req.user.username}`);
      res.json(user);
    } catch (e) {
      if (e.code === "P2002") {
        return res.status(409).json({ error: "Username already exists." });
      }
      log.error({ err: e }, "failed to update account");
      res.status(500).json({ error: "Failed to update account" });
    }
  },
);

router.delete(
  "/accounts/:id",
  authenticateUser,
  requireAdmin,
  validate(accountIdParamSchema),
  async (req, res) => {
    const { id } = req.validated.params;
    try {
      const target = await prisma.adminUser.findUnique({ where: { id }, select: ACCOUNT_SELECT });
      if (!target) return res.status(404).json({ error: "Account not found" });
      if (req.user?.id === id) {
        return res.status(400).json({ error: "You cannot delete your own account." });
      }
      if (target.role === "admin" && target.isActive) {
        const remaining = await countActiveAdmins(id);
        if (remaining < 1) {
          return res.status(400).json({ error: "Cannot delete the last active admin account." });
        }
      }
      await prisma.adminUser.delete({ where: { id } });
      logAudit("delete_account", String(id), `Account deleted: ${target.username} (${target.role}) by ${req.user.username}`);
      res.json({ ok: true });
    } catch (e) {
      log.error({ err: e }, "failed to delete account");
      res.status(500).json({ error: "Failed to delete account" });
    }
  },
);

router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.[config.cookieName];
  if (!token) return res.json({ authenticated: false });
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await prisma.adminUser.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, role: true, isActive: true },
    });
    if (!user || user.isActive === false) return res.json({ authenticated: false });
    res.json({ authenticated: true, id: user.id, username: user.username, role: user.role });
  } catch {
    res.json({ authenticated: false });
  }
});

router.put("/credentials", authenticateUser, validate(changeCredentialsSchema), async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.validated.body;
  const nextName = newUsername !== undefined ? newUsername.trim().toLowerCase() : undefined;
  const nextPass = newPassword !== undefined ? String(newPassword) : undefined;
  try {
    // Scope the change to the signed-in account instead of the first account in
    // the table. Without authenticateUser this endpoint let anyone who knew the
    // seeded password rewrite the primary admin's credentials.
    if (!req.user?.id) return res.status(401).json({ error: "Unauthorized — no session" });
    const user = await prisma.adminUser.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(404).json({ error: "Account not found." });
    const currentHash = hashPassword(currentPassword, user.salt);
    if (!constantTimeCompare(currentHash, user.hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    const data = {};
    if (nextName !== undefined) data.username = nextName;
    if (nextPass !== undefined) {
      const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
      data.salt = salt;
      data.hash = hashPassword(nextPass, salt);
    }
    const updated = await prisma.adminUser.update({ where: { id: user.id }, data });
    const token = signToken(updated);
    setSessionCookie(res, token);
    logAudit("credentials_update", "", "Staff credentials changed");
    res.json({ configured: true, token });
  } catch (e) {
    log.error({ err: e }, "credentials update failed");
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

router.post("/forgot-password", async (req, res) => {
  const { username } = req.body || {};
  const name = (typeof username === "string" ? username : "").trim().toLowerCase();
  const generic = { message: "If an account exists, a reset code has been sent." };
  try {
    if (!name) return res.json(generic);
    const user = await prisma.adminUser.findUnique({ where: { username: name } });
    if (!user || user.isActive === false) return res.json(generic);

    const code = String(randomInt(0, 999999)).padStart(6, "0");
    passwordResets.set(name, { code, expiresAt: Date.now() + 15 * 60 * 1000 });

    const employee = await prisma.employee.findFirst({
      where: { OR: [{ email: name }, { email: { startsWith: name + "@" } }] },
      select: { email: true },
    });
    const clinicName = config.smtp.fromName || "Paw-M Clinic";
    const to = employee?.email || `${name}@placeholder.invalid`;
    await sendMail(buildPasswordResetEmail({ to, code, clinicName }));

    logAudit("forgot_password", "", `Reset code requested for: ${name}`);
    res.json(generic);
  } catch (e) {
    log.error({ err: e }, "forgot-password failed");
    res.json(generic);
  }
});

router.post("/reset-password", async (req, res) => {
  const { username, code, newPassword } = req.body || {};
  const name = (typeof username === "string" ? username : "").trim().toLowerCase();
  const resetCode = typeof code === "string" ? code.trim() : "";

  try {
    if (!name || !resetCode || !newPassword) {
      return res.status(400).json({ error: "username, code, and newPassword are required." });
    }
    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters.` });
    }

    const stored = passwordResets.get(name);
    if (!stored || stored.code !== resetCode) {
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }
    if (Date.now() > stored.expiresAt) {
      passwordResets.delete(name);
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    const user = await prisma.adminUser.findUnique({ where: { username: name } });
    if (!user || user.isActive === false) {
      passwordResets.delete(name);
      return res.status(400).json({ error: "Invalid or expired reset code." });
    }

    const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
    const hash = hashPassword(newPassword, salt);
    await prisma.adminUser.update({ where: { id: user.id }, data: { salt, hash } });
    passwordResets.delete(name);

    logAudit("password_reset", "", `Password reset for: ${name}`);
    res.json({ message: "Password has been reset." });
  } catch (e) {
    log.error({ err: e }, "reset-password failed");
    res.status(500).json({ error: "Failed to reset password." });
  }
});

export default router;
