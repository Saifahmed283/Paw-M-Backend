import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, registerSchema, changeCredentialsSchema } from "../schemas/auth.js";
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
}

function clearSessionCookie(res) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
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
      data: { username: name, salt, hash, role: "staff" },
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
    if (ok) {
      const token = signToken(user);
      setSessionCookie(res, token);
      logAudit("login", "", `Staff sign-in: ${name} [${user.role}]`);
      res.json({ ok, role: user.role, token });
    } else {
      res.json({ ok, role: undefined });
    }
  } catch (e) {
    log.error({ err: e }, "login failed");
    res.status(500).json({ error: "Failed to verify credentials" });
  }
});

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : req.cookies?.[config.cookieName];
  if (!token) return res.json({ authenticated: false });
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await prisma.adminUser.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, role: true },
    });
    if (!user) return res.json({ authenticated: false });
    res.json({ authenticated: true, id: user.id, username: user.username, role: user.role });
  } catch {
    res.json({ authenticated: false });
  }
});

router.put("/credentials", validate(changeCredentialsSchema), async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.validated.body;
  const nextName = newUsername !== undefined ? newUsername.trim().toLowerCase() : undefined;
  const nextPass = newPassword !== undefined ? String(newPassword) : undefined;
  try {
    const user = await prisma.adminUser.findFirst();
    if (!user) return res.status(404).json({ error: "No staff account configured." });
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
    if (!user) return res.json(generic);

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
    if (!user) {
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
