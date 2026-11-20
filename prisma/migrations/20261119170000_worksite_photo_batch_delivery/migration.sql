BEGIN;

ALTER TABLE "worksite_truck_photos" ADD COLUMN "deliveryClaim" UUID;

ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_photo_delivery_claim_check" CHECK (
    "deliveryClaim" IS NULL OR (
      "status" = 'PENDING' AND "approvedAt" IS NOT NULL
      AND "rejectRequestedAt" IS NULL AND "trashRequestedAt" IS NULL
    )
  );

CREATE INDEX "worksite_photo_delivery_claim_idx"
  ON "worksite_truck_photos" ("deliveryClaim") WHERE "deliveryClaim" IS NOT NULL;

COMMIT;
