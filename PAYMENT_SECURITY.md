# Payment verification security model

This backend treats an order as **unpaid until a trusted verification event
settles it**. A customer claim, an uploaded image, or a generic status edit is
never proof of payment.

## Invariant

> Only three code paths may write `Order.paymentStatus = "paid"`:
> authenticated POS cash reception, authenticated staff cash confirmation, and
> admin approval of an InstaPay transfer.

All other APIs either reject `paid` outright or write only non-settling states:
`unpaid`, `proof_submitted`, `under_review`, or `rejected`. The Finance
`Payment` row is a mirror of the order and cannot be used to settle an order
from the outside.

## Payment status lifecycle

| State | Meaning | Written by |
| --- | --- | --- |
| `unpaid` | No accepted proof yet (also used after rejection) | checkout, cash-drawer flows, rejection |
| `proof_submitted` | Customer supplied transfer details; awaiting review | transfer submission |
| `under_review` | Reserved for a reviewer workflow | verification APIs |
| `paid` | Cash counted or transfer matched to a bank reference | trusted verification events only |
| `rejected` | Verification failed; customer may resubmit | admin rejection / generic rejection patch |

`PaymentVerification.decision` is stored as text: `submitted`, `under_review`,
`approved`, `rejected`, `superseded`. A resubmission supersedes earlier open
verifications for the same order.

## Trusted settlement paths

| Event | Endpoint | Auth | Required input | Effect |
| --- | --- | --- | --- | --- |
| POS cash reception | `POST /api/orders` with `source:"pos"` | staff session | `cashReceived:true` and `cashReceivedAmount` equal to the order total | creates an approved `cash_reception` verification, sets `paid`, `paidAt`, and order `confirmed` |
| Staff cash confirmation | `POST /api/orders/:id/confirm-cash` | staff session | `amountReceived` exactly matching the order total | creates an approved `cash_reception` verification, sets `paid`, `paidAt`, and `confirmed` for pending orders |
| Admin transfer approval | `POST /api/payment-verification/admin/:verificationId/approve` | admin staff session | `bankTransactionReference` (unique) | marks the verification `approved`, sets `paid`, `paidAt`, `paymentRef`, and `confirmed` for pending orders |

Every path runs in a database transaction, locks the order/verification row
with `FOR UPDATE`, records reviewer ID/time, writes an audit log entry, syncs
the canonical `kind:"order"` Finance payment, and sends a success email when an
address is present.

## Closed settlement holes

- Checkout schema is strict: `paymentRef`, `proofImage`, `fawry`, and
  client-supplied `cashReceived` are rejected. Every non-POS order starts
  `unpaid` / `pending` with empty `paymentRef` and `proofImage`.
- Each order uses exactly one trusted settlement path. Mixed cash + InstaPay
  splits are rejected by the POS UI and backend; otherwise a cash attestation
  could settle the transfer portion without bank verification.
- `POST /api/orders/:id/transfer-submission` (guest-capable) only records
  evidence and moves the order to `proof_submitted`; it never marks it paid.
  All four proof fields — sender name, real transfer reference, transfer date
  and a screenshot — are required so staff can match the claim to the bank
  statement. The legacy `POST /api/orders/:id/payment-proof` is rate-limited,
  requires the same real reference and a screenshot, and forwards to that flow;
  an image-only request is rejected rather than receiving a generated reference.
- `PATCH /api/orders/:id/payment` refuses `paid` with:
  `Use cash confirmation or transfer verification to mark an order paid.`
  It also refuses `fawry`.
- `PATCH /api/orders/:id/status` refuses `completed` until payment is paid:
  `Payment must be verified before completing an order.`
- Finance APIs (`PATCH /api/payments/:id`, `POST /api/payments/:id/settle`,
  `POST /api/payments`) refuse to settle `kind:"order"` rows with:
  `Order payments are settled through verification only.`
  `syncPaymentToOrder` also throws if a Finance edit tries to push `paid` back
  onto an order.
- `fawry` remains in the Prisma enum and legacy Finance method lists for data
  compatibility, but no order API accepts it and no Fawry reference is
  generated. The unused `fawryReference()` helper is not called by checkout.

## Transfer evidence

Evidence is stored in private S3-compatible object storage, never as a URL or
base64 blob on the `Order` row. The submission response exposes only
`{ id, decision, createdAt }`; the object key is visible only to staff list APIs.

Staff can obtain a five-minute GET link:

- `GET /api/payment-verification/admin/:verificationId/evidence-url`
- Response: `{ "url": "...", "expiresAt": "2026-11-20T12:05:00.000Z" }`

This `{ url, expiresAt }` shape is an intentional contract deviation from a
bare URL so callers can display the exact expiry.

If the database write fails after an object was stored, the object is deleted
on a best-effort basis.

## Admin and reconciliation endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/payment-verification/admin/submissions?status=submitted\|all` | admin | List verifications with joined customer and reviewer data; `status` may be any `PaymentVerification.decision` value |
| `POST /api/payment-verification/admin/:verificationId/reject` | admin | Reject with a reason, return the order to `unpaid`, allow resubmission |
| `GET /api/payment-verification/admin/:verificationId/evidence-url` | admin | Issue the five-minute private link |
| `POST /api/payment-verification/admin/cash-drawer/close` | staff | Record expected/counted/variance for the current Cairo day |
| `GET /api/payment-verification/admin/cash-drawer?date=YYYY-MM-DD` | staff | Show the latest close, recomputed expected physical-cash total, and approved cash receptions |

The drawer aggregates only verifications with `source:"cash_reception"`.
Approved InstaPay transfers settle orders but are bank deposits, not cash in
the till, so they are excluded from expected cash and variance.

Client session tokens are explicitly rejected from the admin surface with
`403 Forbidden — staff access only`; missing tokens still yield `401`.

## Deployment configuration

Apply the migration before starting the new API version:

```bash
npx prisma migrate deploy
npx prisma generate
```

Add these variables to the backend runtime environment (also documented in
`.env.example`):

| Variable | Required | Notes |
| --- | --- | --- |
| `EVIDENCE_S3_ENDPOINT` | yes | S3-compatible endpoint (e.g. DigitalOcean Spaces) |
| `EVIDENCE_S3_REGION` | yes | Region code used by the SDK |
| `EVIDENCE_S3_BUCKET` | yes | Private bucket; no public read policy or ACL |
| `EVIDENCE_S3_ACCESS_KEY` | yes | Scoped key with put/get/delete only on that bucket |
| `EVIDENCE_S3_SECRET_KEY` | yes | Secret for the key above |
| `TRANSFER_SUBMISSION_RATE_MAX` | no | Transfer submissions per 15 minutes per client; default `8` |

The bucket must remain private. If any evidence variable is missing, transfer
submissions with an image and evidence-link issuance fail fast with
`503 EVIDENCE_STORAGE_NOT_CONFIGURED` rather than falling back to a public URL.

No `.do/app.yaml`, frontend, or deployment manifest was changed by this work;
the variables above must be supplied through the existing deployment secret
configuration.

## Verification evidence

- `npm test`: 21 files passed, 179 tests passed.
- `npx prisma validate`: passed.
- `npx prisma generate`: generated client types include `PaymentVerification` and
  `CashDrawerClose`; on this Windows workstation the native engine DLL rename
  can fail with `EPERM` while a dev server holds the file. Re-run after stopping
  that process; do not kill it from the test suite.
