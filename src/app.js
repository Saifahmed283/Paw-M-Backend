import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import routes from "./routes/index.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { withTimeout } from "./lib/utils.js";

const healthLog = logger.child({ module: "health" });

const app = express();

// Trust the immediate reverse-proxy hop (DigitalOcean LB in production) so
// req.ip (and therefore rate-limit keys) is the real client, not the proxy.
app.set("trust proxy", 1);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: config.isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", config.frontendUrl, "https://cdn.pixabay.com", "https://maps.googleapis.com"],
      fontSrc: ["'self'"],
      mediaSrc: ["'self'", "https://cdn.pixabay.com"],
    },
  } : false,
  crossOriginEmbedderPolicy: config.isProduction,
}));
app.use(helmet.referrerPolicy({ policy: "no-referrer" }));
if (config.isProduction) {
  app.use(helmet.crossOriginOpenerPolicy({ policy: "same-origin" }));
}

// ── CORS ─────────────────────────────────────────────────────────────────────
// In production, restrict to the configured allowlist. In development, reflect
// the request origin so LAN phones and tunnels (any host/port) work without
// editing an IP into .env.
app.use(cors({
  origin: config.isProduction ? config.corsOrigins : true,
  credentials: true,
}));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────────────
const sensitiveLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.sensitiveMax,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for credential/verification endpoints (login, register,
// forgot/reset, client register/verify/login). Configured as RATE_LIMIT_AUTH_MAX.
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/auth", authLimiter);
app.use("/api/client-auth", authLimiter);

app.use("/api/bookings", sensitiveLimiter);
app.use("/api/orders", sensitiveLimiter);
app.use("/api/reviews", sensitiveLimiter);

// ── Health checks (before rate limiter) ──────────────────────────────────────
// Liveness only confirms the process is up. It deliberately does NOT touch the
// database: restarting the app cannot repair a database outage, so failing
// liveness on a DB blip would escalate a brief blip into a restart loop. This is
// the endpoint the Dockerfile HEALTHCHECK polls.
app.get("/api/health", (_req, res) =>
  res.json({
    status: "ok",
    db: "unchecked",
    uptimeSeconds: Math.round(process.uptime()),
  })
);

// Readiness confirms this instance can actually serve traffic, by running a real
// query under a hard timeout. It answers 503 when the database is unreachable
// so the platform routes away from a degraded instance rather than letting
// clients collect gateway errors.
app.get("/api/ready", async (_req, res) => {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

  try {
    await withTimeout(
      prisma.$queryRaw`SELECT 1`,
      config.database.healthTimeoutMs,
      "readiness database check"
    );
    res.json({
      status: "ready",
      db: "connected",
      latencyMs: Math.round(elapsedMs()),
    });
  } catch (err) {
    healthLog.warn(
      { err, latencyMs: Math.round(elapsedMs()) },
      "readiness check failed — database unavailable"
    );
    res.status(503).json({ status: "degraded", db: "disconnected" });
  }
});

// ── General API rate limit ───────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ── Sensitive routes rate limit ──────────────────────────────────────────────
app.use("/api/payroll", sensitiveLimiter);
app.use("/api/employees", sensitiveLimiter);
app.use("/api/settings", sensitiveLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api", routes);

// ── Graceful handling of client disconnects (prevents "Error: aborted" noise) ──
// This catches the "aborted" error emitted when a client closes the connection
// before the response finishes. It's normal behavior, not a server error.
app.use((err, req, res, next) => {
  if (err?.code === "ECONNRESET" || err?.message === "aborted" || err?.name === "AbortError") {
    // Client disconnected - this is normal, don't log as error
    return;
  }
  next(err);
});

// ── Error handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export { app };
