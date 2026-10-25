CREATE FUNCTION vehicle_import_immutable_source() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."status" <> 'PROCESSING' AND (NEW."companyId",NEW."truckId",NEW."sourceHash",NEW."storageId",NEW."mime",NEW."filename") IS DISTINCT FROM (OLD."companyId",OLD."truckId",OLD."sourceHash",OLD."storageId",OLD."mime",OLD."filename") THEN
 RAISE EXCEPTION 'import source immutable' USING ERRCODE='23514'; END IF;
 IF OLD."status" IN ('APPROVED','CONSUMED') AND (NEW."candidates",NEW."revision",NEW."reviewedAt",NEW."reviewedById") IS DISTINCT FROM (OLD."candidates",OLD."revision",OLD."reviewedAt",OLD."reviewedById") THEN
 RAISE EXCEPTION 'approved import immutable' USING ERRCODE='23514'; END IF;
 IF OLD."status"='CONSUMED' AND (NEW."status",NEW."consumptionKey") IS DISTINCT FROM (OLD."status",OLD."consumptionKey") THEN
 RAISE EXCEPTION 'consumed import immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vehicle_import_immutable_source BEFORE UPDATE ON "vehicle_address_imports" FOR EACH ROW EXECUTE FUNCTION vehicle_import_immutable_source();
