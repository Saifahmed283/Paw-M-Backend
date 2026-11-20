import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { validateProofImage } from "./orders.js";

const KEY_PREFIX = "payment-evidence";
const ALLOWED_IMAGE_TYPES = new Set(["png", "jpeg", "jpg", "webp", "gif", "bmp"]);

/**
 * Payment evidence is private. Keys are returned to the API layer only, never
 * public URLs and never the original base64 payload. The bucket must not have a
 * public read policy; access is granted exclusively through short-lived GET
 * presignatures issued to staff by `presignEvidence`.
 */
function storageConfig() {
  const cfg = {
    endpoint: process.env.EVIDENCE_S3_ENDPOINT,
    region: process.env.EVIDENCE_S3_REGION,
    bucket: process.env.EVIDENCE_S3_BUCKET,
    accessKey: process.env.EVIDENCE_S3_ACCESS_KEY,
    secretKey: process.env.EVIDENCE_S3_SECRET_KEY,
  };
  if (Object.values(cfg).some((value) => !value)) {
    throw Object.assign(new Error("Payment evidence storage is not configured."), {
      status: 503,
      code: "EVIDENCE_STORAGE_NOT_CONFIGURED",
    });
  }
  return cfg;
}

let cached = { signature: "", client: null, bucket: "" };

function clientFor(cfg) {
  const signature = [cfg.endpoint, cfg.region, cfg.bucket, cfg.accessKey, cfg.secretKey].join("|");
  if (cached.signature !== signature) {
    cached = {
      signature,
      bucket: cfg.bucket,
      client: new S3Client({
        endpoint: cfg.endpoint,
        region: cfg.region,
        // DigitalOcean Spaces requires path-style addressing.
        forcePathStyle: true,
        credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      }),
    };
  }
  return cached;
}

function safeSegment(value, max = 80) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, max) || "unknown";
}

// CUID-shaped identifier: time-ordered prefix plus cryptographic randomness.
function evidenceCuid() {
  return `c${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}

function imageParts(dataUrl) {
  const match = /^data:image\/([A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  const subtype = match?.[1].toLowerCase() ?? "";
  if (!match || !ALLOWED_IMAGE_TYPES.has(subtype)) {
    throw Object.assign(new Error("Invalid proof image format."), { status: 400, code: "INVALID_EVIDENCE_IMAGE" });
  }
  return { subtype, base64: match[2] };
}

/** Store a validated data URL in private object storage. Returns its object key. */
export async function storeEvidence(dataUrl, { orderId, kind } = {}) {
  const cfg = storageConfig();
  const check = validateProofImage(dataUrl);
  if (!check.valid) {
    throw Object.assign(new Error(check.error || "Invalid proof image."), {
      status: 400,
      code: "INVALID_EVIDENCE_IMAGE",
    });
  }
  const { subtype, base64 } = imageParts(dataUrl);
  const ext = { jpeg: "jpg", jpg: "jpg", svg: "svg" }[subtype] ?? subtype.replace(/[^a-z0-9]/g, "").slice(0, 8) ?? "bin";
  const key = `${KEY_PREFIX}/${safeSegment(orderId)}/${evidenceCuid()}.${ext || "bin"}`;
  const { client, bucket } = clientFor(cfg);
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(base64, "base64"),
    ContentType: `image/${subtype}`,
    ServerSideEncryption: "AES256",
    CacheControl: "private, no-store",
    Metadata: { orderId: safeSegment(orderId), kind: safeSegment(kind, 30) },
  }));
  return key;
}

/** Issue a short-lived private GET URL. Returns { url, expiresAt }. */
export async function presignEvidence(key, expiresIn = 300) {
  if (!key || typeof key !== "string") {
    throw Object.assign(new Error("Evidence key is required."), { status: 400, code: "EVIDENCE_KEY_REQUIRED" });
  }
  const cfg = storageConfig();
  const { client, bucket } = clientFor(cfg);
  const url = await getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    // Evidence is opened by staff; force a download so stored content cannot
    // execute in the dashboard origin even if a future type is allowed.
    ResponseContentDisposition: "attachment; filename=\"payment-evidence\"",
    ResponseContentType: "application/octet-stream",
  }), { expiresIn });
  return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

/** Best-effort cleanup after a failed database write. Never throws. */
export async function deleteEvidence(key) {
  if (!key || typeof key !== "string") return false;
  try {
    const cfg = storageConfig();
    const { client, bucket } = clientFor(cfg);
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
