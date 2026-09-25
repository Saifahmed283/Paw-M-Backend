import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { buildDatabaseUrl } from "./db-url.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "prisma" });
const globalForPrisma = globalThis;

function createPrismaClient() {
  const client = new PrismaClient({
    // Applied in code rather than left to DATABASE_URL so a deployment gets
    // fail-fast timeouts without anyone having to remember extra env vars.
    ...(config.databaseUrl
      ? { datasources: { db: { url: buildDatabaseUrl(config.databaseUrl, config.database) } } }
      : {}),
    log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
  });

  // Without a listener, client-level errors (stale pooled connections, for
  // example) are swallowed, which is exactly the signal needed when diagnosing
  // an unreachable database in production.
  client.$on("error", (err) => log.error({ err }, "prisma client error"));

  return client;
}

export const prisma = globalForPrisma.__prisma ?? createPrismaClient();

if (config.nodeEnv !== "production") {
  globalForPrisma.__prisma = prisma;
}
