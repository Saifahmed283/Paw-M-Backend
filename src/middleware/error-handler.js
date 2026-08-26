import { ZodError } from "zod";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "error-handler" });

export function notFoundHandler(req, res, _next) {
  res.status(404).json({ error: "Not found" });
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  log.error({ err, req: { method: req.method, url: req.url } }, "unhandled error");

  const statusCode = err.statusCode || 500;
  const response = { error: statusCode === 500 ? "Internal server error" : err.message };

  if (!config.isProduction && statusCode === 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
