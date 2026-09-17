import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  try {
    const envPath = resolve(__dirname, "..", ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file not found — rely on environment
  }
}

loadEnvFile();

export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || "development",
  get isProduction() {
    return this.nodeEnv === "production";
  },

  databaseUrl: process.env.DATABASE_URL,

  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me-in-production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  cookieName: process.env.COOKIE_NAME || "paw-m-session",
  csrfCookieName: process.env.CSRF_COOKIE_NAME || "paw-m-csrf-token",

  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
    : ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"],

  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",

  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    fromName: process.env.SMTP_FROM_NAME || "Paw-M Clinic",
    fromAddr: process.env.SMTP_FROM_ADDR || "",
  },

  rateLimit: {
    windowMs: 15 * 60 * 1000,
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX) || 20,
    apiMax: Number(process.env.RATE_LIMIT_API_MAX) || 100,
    sensitiveMax: Number(process.env.RATE_LIMIT_SENSITIVE_MAX) || 30,
  },

  bodyLimit: process.env.BODY_LIMIT || "8mb",
};

if (config.jwtSecret === "dev-secret-change-me-in-production") {
  if (config.isProduction || process.env.ALLOW_INSECURE_DEV_SECRET !== "1") {
    throw new Error(
      "FATAL: JWT_SECRET is set to the default value. Set the JWT_SECRET environment variable (or, for a local development instance only, set ALLOW_INSECURE_DEV_SECRET=1)."
    );
  }
}

if (config.isProduction && !config.databaseUrl) {
  throw new Error("FATAL: DATABASE_URL is not set.");
}
