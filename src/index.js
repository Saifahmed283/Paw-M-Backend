import { app } from "./app.js";
import { config } from "./config.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { archiveFinishedDayRecords } from "./lib/utils.js";

const log = logger.child({ module: "server" });

process.on("unhandledRejection", (reason) => {
  log.error({ err: reason }, "unhandled rejection — keeping server alive");
});

process.on("uncaughtException", (err) => {
  log.fatal({ err }, "uncaught exception — server will exit");
  // stdout is a pipe inside a container, so the write is async. Exiting inline
  // can truncate the single most useful line when diagnosing a crash loop, so
  // flush first and keep a hard-exit backstop in case the flush never settles.
  logger.flush(() => process.exit(1));
  setTimeout(() => process.exit(1), 2000).unref();
});

archiveFinishedDayRecords()
  .then((result) => {
    if (result.bookings > 0 || result.orders > 0) {
      log.info({ bookings: result.bookings, orders: result.orders }, "auto-archived stale records on startup");
    }
  })
  .catch((err) => log.error({ err }, "startup archive failed"));

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
