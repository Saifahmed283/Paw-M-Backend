import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendMail, buildClientVerificationEmail } from "../lib/email.js";

const router = Router();
const log = logger.child({ module: "routes/client-auth" });

const BCRYPT_ROUNDS = 12;
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += bytes[i].toString(10).slice(-1);
  }
  return code;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

// POST /api/client-auth/register — request email verification
router.post("/register", async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body ?? {};
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: "fullName, email, and password are required." });
    }
    if (typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = await prisma.clientAccount.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const salt = makeSalt();
    const passwordHash = hashPassword(password);
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);

    await prisma.clientVerification.upsert({
      where: { email },
      update: {
        fullName,
        phone: phone || "",
        passwordHash,
        salt,
        codeHash,
        attempts: 0,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
      create: {
        email,
        fullName,
        phone: phone || "",
        passwordHash,
        salt,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    try {
      const clinicName = "Paw-M Clinic";
      await sendMail(buildClientVerificationEmail({ to: email, code, clinicName }));
    } catch (mailErr) {
      log.error({ err: mailErr }, "failed to send verification email");
    }

    log.info({ email }, "verification code sent");
    res.status(202).json({ message: "Verification code sent to your email." });
  } catch (error) {
    log.error({ err: error }, "register failed");
    res.status(500).json({ error: "Registration failed." });
  }
});

// POST /api/client-auth/verify — verify code and create account + session
router.post("/verify", async (req, res) => {
  try {
    const { email, code } = req.body ?? {};
    if (!email || !code) {
      return res.status(400).json({ error: "email and code are required." });
    }

    const verification = await prisma.clientVerification.findUnique({ where: { email } });
    if (!verification) {
      return res.status(400).json({ error: "No pending verification for this email." });
    }
    if (new Date() > verification.expiresAt) {
      await prisma.clientVerification.delete({ where: { email } });
      return res.status(400).json({ error: "Verification code has expired. Please register again." });
    }
    if (verification.attempts >= 5) {
      await prisma.clientVerification.delete({ where: { email } });
      return res.status(429).json({ error: "Too many failed attempts. Please register again." });
    }

    const codeValid = await bcrypt.compare(code, verification.codeHash);
    if (!codeValid) {
      await prisma.clientVerification.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid verification code." });
    }

    const client = await prisma.clientAccount.create({
      data: {
        email,
        fullName: verification.fullName,
        phone: verification.phone,
        passwordHash: verification.passwordHash,
        salt: verification.salt,
      },
    });

    await prisma.clientVerification.delete({ where: { email } });

    const token = generateToken();
    await prisma.clientSession.create({
      data: {
        tokenHash: hashToken(token),
        clientId: client.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    log.info({ clientId: client.id }, "client verified and registered");
    res.status(201).json({
      token,
      client: { id: client.id, email: client.email, fullName: client.fullName, phone: client.phone },
    });
  } catch (error) {
    log.error({ err: error }, "verify failed");
    res.status(500).json({ error: "Verification failed." });
  }
});

// POST /api/client-auth/login — login with email + password
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required." });
    }

    const client = await prisma.clientAccount.findUnique({ where: { email } });
    if (!client) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = bcrypt.compareSync(password, client.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = generateToken();
    await prisma.clientSession.create({
      data: {
        tokenHash: hashToken(token),
        clientId: client.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    log.info({ clientId: client.id }, "client logged in");
    res.json({
      token,
      client: { id: client.id, email: client.email, fullName: client.fullName, phone: client.phone },
    });
  } catch (error) {
    log.error({ err: error }, "login failed");
    res.status(500).json({ error: "Login failed." });
  }
});

// POST /api/client-auth/logout — destroy session
router.post("/logout", async (req, res) => {
  try {
    const token = req.body?.token;
    if (token) {
      await prisma.clientSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    res.json({ message: "Logged out." });
  } catch (error) {
    log.error({ err: error }, "logout failed");
    res.json({ message: "Logged out." });
  }
});

export default router;
