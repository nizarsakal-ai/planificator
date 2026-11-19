BEGIN;
LOCK TABLE "worksite_truck_photos" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "deliveryClaim" IS NOT NULL) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSÉ : un lot de photos est réservé pour envoi ou réconciliation.';
  END IF;
END $$;
ALTER TABLE "worksite_truck_photos" DROP COLUMN "deliveryClaim";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119170000_worksite_photo_batch_delivery';
COMMIT;
