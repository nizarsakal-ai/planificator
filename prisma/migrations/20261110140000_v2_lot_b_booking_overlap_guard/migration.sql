-- V2 06/11/2026 — garde en base contre la double réservation d'un équipement (échec réel VM v6 : deux réservations
-- simultanées chevauchantes acceptées). Migration ADDITIVE : une fonction et un déclencheur, aucune donnée réécrite, aucune
-- table ni colonne modifiée. Le service garde sa propre vérification (règle « fin effective » d'une sortie en retard) ;
-- ce déclencheur garantit l'invariant minimal quel que soit le chemin d'écriture : deux réservations ACTIVES (RESERVED ou
-- CHECKED_OUT) d'un même équipement ne se chevauchent jamais sur [startAt, endAt).
-- Sérialisation : la ligne de l'équipement est verrouillée (FOR UPDATE) DANS le déclencheur, puis l'existence d'un
-- chevauchement est relue par une nouvelle instruction (nouvel instantané en READ COMMITTED) : la seconde écriture
-- concurrente attend la validation de la première et la voit.
BEGIN;

CREATE OR REPLACE FUNCTION equipment_bookings_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW."status"::text NOT IN ('RESERVED', 'CHECKED_OUT') THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "equipment" WHERE "id" = NEW."equipmentId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM "equipment_bookings" b
    WHERE b."companyId" = NEW."companyId" AND b."equipmentId" = NEW."equipmentId" AND b."id" <> NEW."id"
      AND b."status"::text IN ('RESERVED', 'CHECKED_OUT')
      AND b."startAt" < NEW."endAt" AND NEW."startAt" < b."endAt"
  ) THEN
    RAISE EXCEPTION 'EQUIPMENT_BOOKING_OVERLAP: réservation chevauchante pour l''équipement %', NEW."equipmentId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER equipment_bookings_no_overlap
  BEFORE INSERT OR UPDATE OF "status", "startAt", "endAt", "equipmentId", "companyId" ON "equipment_bookings"
  FOR EACH ROW EXECUTE FUNCTION equipment_bookings_no_overlap();

COMMIT;
