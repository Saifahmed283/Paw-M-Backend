import { app } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";

const log = logger.child({ module: "server" });

const server = app.listen(config.port, () => {
  log.info({ port: config.port, env: config.nodeEnv }, "Paw-M Backend API running");
});

async function shutdown(signal) {
  log.info({ signal }, "shutting down gracefully");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => {
    log.error("forced shutdown after timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
