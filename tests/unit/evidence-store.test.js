import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn(async () => ({}));
  const S3Client = vi.fn(function MockS3Client(config) {
    this.config = config;
    this.send = (command) => send(command);
  });
  class PutObjectCommand {
    constructor(input) { this.input = input; this.commandName = "PutObject"; }
  }
  class GetObjectCommand {
    constructor(input) { this.input = input; this.commandName = "GetObject"; }
  }
  class DeleteObjectCommand {
    constructor(input) { this.input = input; this.commandName = "DeleteObject"; }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, __send: send };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client, command, options) =>
    `https://objects.test/${command.input.Key}?X-Amz-Expires=${options.expiresIn}`),
}));

import { __send, S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storeEvidence, presignEvidence, deleteEvidence } from "../../src/services/evidence-store.js";

const ENV_KEYS = [
  "EVIDENCE_S3_ENDPOINT", "EVIDENCE_S3_REGION", "EVIDENCE_S3_BUCKET",
  "EVIDENCE_S3_ACCESS_KEY", "EVIDENCE_S3_SECRET_KEY",
];
const PNG = `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}`;

function setEnv(enabled = true) {
  for (const key of ENV_KEYS) {
    if (enabled) process.env[key] = key === "EVIDENCE_S3_ENDPOINT" ? "https://spaces.test" : "test-value";
    else delete process.env[key];
  }
}

describe("Private evidence store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv(true);
    __send.mockResolvedValue({});
  });
  afterEach(() => setEnv(false));

  it("throws 503 EVIDENCE_STORAGE_NOT_CONFIGURED when env is missing", async () => {
    setEnv(false);
    await expect(storeEvidence(PNG, { orderId: "ORD-1", kind: "transfer" }))
      .rejects.toMatchObject({ status: 503, code: "EVIDENCE_STORAGE_NOT_CONFIGURED" });
    await expect(presignEvidence("some/key.png"))
      .rejects.toMatchObject({ status: 503, code: "EVIDENCE_STORAGE_NOT_CONFIGURED" });
    expect(S3Client).not.toHaveBeenCalled();
  });

  it("stores a valid image under a private prefixed key with SSE enabled", async () => {
    const key = await storeEvidence(PNG, { orderId: "ORD-1", kind: "transfer" });
    expect(key).toMatch(/^payment-evidence\/ORD-1\/c[a-z0-9]+\.png$/);
    expect(key).not.toContain("base64");
    const command = __send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "test-value",
      Key: key,
      ContentType: "image/png",
      ServerSideEncryption: "AES256",
      CacheControl: "private, no-store",
    });
    expect(command.input.ACL).toBeUndefined();
    expect(Buffer.isBuffer(command.input.Body)).toBe(true);
    expect(S3Client.mock.calls[0][0]).toMatchObject({ forcePathStyle: true, endpoint: "https://spaces.test" });
  });

  it("presigns a GET for five minutes and reports the expiry", async () => {
    const before = Date.now();
    const result = await presignEvidence("payment-evidence/ORD-1/abc.png");
    expect(result.url).toContain("X-Amz-Expires=300");
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    const command = getSignedUrl.mock.calls[0][1];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input.Key).toBe("payment-evidence/ORD-1/abc.png");
    expect(command.input.ResponseContentDisposition).toContain("attachment");
    expect(command.input.ResponseContentType).toBe("application/octet-stream");
    expect(getSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 300 });
  });

  it("rejects active SVG evidence instead of storing it", async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}`;
    await expect(storeEvidence(svg, { orderId: "ORD-1", kind: "transfer" }))
      .rejects.toMatchObject({ status: 400 });
    expect(__send).not.toHaveBeenCalled();
  });

  it("never throws from best-effort deletion", async () => {
    __send.mockRejectedValueOnce(new Error("gone"));
    await expect(deleteEvidence("payment-evidence/ORD-1/abc.png")).resolves.toBe(false);
    await expect(deleteEvidence("")).resolves.toBe(false);
  });
});
