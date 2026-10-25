-- No reset path: an approved source/result can never be made mutable again.
CREATE OR REPLACE FUNCTION vehicle_import_immutable_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW."id",NEW."companyId",NEW."truckId",NEW."createdById",NEW."createdAt",NEW."sourceHash",NEW."mime",NEW."filename") IS DISTINCT FROM (OLD."id",OLD."companyId",OLD."truckId",OLD."createdById",OLD."createdAt",OLD."sourceHash",OLD."mime",OLD."filename") THEN
  RAISE EXCEPTION 'import identity immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."status" = OLD."status" THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'same-state import mutation forbidden' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NOT ((OLD."status"='PROCESSING' AND NEW."status" IN ('DRAFT','FAILED')) OR (OLD."status"='DRAFT' AND NEW."status"='APPROVED') OR (OLD."status"='APPROVED' AND NEW."status"='CONSUMED')) THEN
  RAISE EXCEPTION 'import transition forbidden' USING ERRCODE='23514';
 END IF;
 IF OLD."status" <> 'PROCESSING' AND NEW."storageId" IS DISTINCT FROM OLD."storageId" THEN
  RAISE EXCEPTION 'import source immutable' USING ERRCODE='23514';
 END IF;
 IF OLD."status"='PROCESSING' AND (NEW."revision" <> 0 OR NEW."reviewedById" IS NOT NULL OR NEW."reviewedAt" IS NOT NULL OR NEW."consumptionKey" IS NOT NULL) THEN
  RAISE EXCEPTION 'import processing cannot approve' USING ERRCODE='23514';
 END IF;
 IF OLD."status"='DRAFT' AND (NEW."revision" <> OLD."revision"+1 OR NEW."reviewedById" IS NULL OR NEW."reviewedAt" IS NULL OR NEW."consumptionKey" IS NOT NULL) THEN
  RAISE EXCEPTION 'explicit revision review required' USING ERRCODE='23514';
 END IF;
 IF OLD."status"='APPROVED' AND ((NEW."candidates",NEW."warnings",NEW."revision",NEW."reviewedAt",NEW."reviewedById") IS DISTINCT FROM (OLD."candidates",OLD."warnings",OLD."revision",OLD."reviewedAt",OLD."reviewedById") OR NEW."consumptionKey" IS NULL) THEN
  RAISE EXCEPTION 'approved import immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
