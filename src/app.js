import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import routes from "./routes/index.js";
import { notFoundHandler, errorHandler } from "./middleware/error-handler.js";
import { logger } from "./lib/logger.js";

const app = express();

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
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));
app.use(cookieParser());

// ── Rate limiting ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

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

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/credentials", authLimiter);

// ── Health check (before rate limiter) ───────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ status: "ok", db: "connected" }));

// ── General API rate limit ───────────────────────────────────────────────────
app.use("/api", apiLimiter);

// ── Sensitive routes rate limit ──────────────────────────────────────────────
app.use("/api/payroll", sensitiveLimiter);
app.use("/api/employees", sensitiveLimiter);
app.use("/api/settings", sensitiveLimiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api", routes);

// ── Error handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export { app };
