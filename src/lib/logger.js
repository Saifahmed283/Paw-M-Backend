import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.isProduction ? "info" : "debug",
  transport: config.isProduction
    ? undefined
    : {
        target: "pino/file",
        options: { destination: 1, colorize: true },
      },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "password", "hash", "salt"],
    censor: "[REDACTED]",
  },
});

export function childLogger(name) {
  return logger.child({ module: name });
}
