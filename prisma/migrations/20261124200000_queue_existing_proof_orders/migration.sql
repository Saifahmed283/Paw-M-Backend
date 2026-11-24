-- Backfill the verification queue for sales that predate the POS auto-queue.
--
-- Fawry/InstaPay orders start unpaid and are settled only from the payment
-- verification queue. Older unpaid orders never received a verification row,
-- so cashiers saw an empty queue even though money was outstanding. This adds
-- one placeholder review row per still-unpaid proof order; a later customer
-- proof submission supersedes it.

INSERT INTO "PaymentVerification"
    ("id", "orderId", "paymentId", "method", "amount", "source", "decision", "note", "createdAt")
SELECT
    'PV-BACKFILL-' || replace(o."id", '-', ''),
    o."id",
    linked."id",
    o."paymentMethod",
    o."total",
    CASE WHEN o."source" = 'pos' THEN 'pos_transfer' ELSE 'store_transfer' END,
    'submitted',
    'Existing sale queued for bank-statement verification',
    o."createdAt"
FROM "Order" o
LEFT JOIN LATERAL (
    SELECT p."id"
    FROM "Payment" p
    WHERE p."orderId" = o."id"
    ORDER BY p."createdAt" ASC
    LIMIT 1
) linked ON true
WHERE o."paymentMethod" IN ('fawry', 'instapay')
  AND o."paymentStatus" <> 'paid'
  AND NOT EXISTS (
      SELECT 1
      FROM "PaymentVerification" pv
      WHERE pv."orderId" = o."id"
        AND pv."decision" IN ('submitted', 'under_review')
  )
  AND NOT EXISTS (
      SELECT 1
      FROM "PaymentVerification" existing
      WHERE existing."id" = 'PV-BACKFILL-' || replace(o."id", '-', '')
  );
