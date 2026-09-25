import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { app } from "../../src/app.js";
import { config } from "../../src/config.js";

const stubHealthyDatabase = () => {
  mockPrisma.$queryRaw.mockReset();
  mockPrisma.$queryRaw.mockResolvedValue([{ ok: 1 }]);
};

describe("health endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubHealthyDatabase();
  });

  describe("GET /api/health (liveness)", () => {
    it("reports the process as up", async () => {
      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(typeof res.body.uptimeSeconds).toBe("number");
    });

    it("no longer claims the database is connected", async () => {
      const res = await request(app).get("/api/health");

      expect(res.body.db).toBe("unchecked");
      expect(res.body.db).not.toBe("connected");
    });

    it("does not query the database, so a DB outage cannot cause a restart loop", async () => {
      await request(app).get("/api/health");

      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("stays healthy while the database is unreachable", async () => {
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockRejectedValue(new Error("connection refused"));

      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });
  });

  describe("GET /api/ready (readiness)", () => {
    it("reports ready once a real query succeeds", async () => {
      const res = await request(app).get("/api/ready");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.db).toBe("connected");
      expect(typeof res.body.latencyMs).toBe("number");
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("answers 503 when the query fails", async () => {
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockRejectedValue(new Error("P1001 cannot reach database server"));

      const res = await request(app).get("/api/ready");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: "degraded", db: "disconnected" });
    });

    it("does not leak the underlying error message to callers", async () => {
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockRejectedValue(new Error("password authentication failed for user doadmin"));

      const res = await request(app).get("/api/ready");

      expect(JSON.stringify(res.body)).not.toContain("doadmin");
    });

    it("answers 503 instead of hanging when the database stops responding", async () => {
      const original = config.database.healthTimeoutMs;
      config.database.healthTimeoutMs = 60;
      mockPrisma.$queryRaw.mockReset();
      mockPrisma.$queryRaw.mockReturnValue(new Promise(() => {}));

      try {
        const res = await request(app).get("/api/ready");

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: "degraded", db: "disconnected" });
      } finally {
        config.database.healthTimeoutMs = original;
      }
    });
  });
});
