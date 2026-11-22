-- 24/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-8D : rétention RGPD des connexions réelles (SECURITY-SPEC §28, plan LOT-8
-- §7 condition 4, fiche validée par Nizar le 22/11/2026). Migration ADDITIVE : une colonne nullable, deux contraintes
-- remplacées (élargies), deux fonctions de déclencheur remplacées. Aucune donnée existante lue ni écrite.
-- À appliquer avec le rôle propriétaire (docs/runbooks/DB-APP-ROLE.md), AVANT la fusion (garde de schéma du build).
--
-- 1. Zone de transit : la suppression reste interdite, sauf :
--    - purge de rétention : élément non synchronisé depuis plus de 365 jours, dans une transaction qui l'annonce
--      (`planificator.retention_purge = on`) ; l'âge est vérifié par la base elle-même (horloge du serveur) ;
--    - effacement ciblé (droit des personnes) : un seul élément, désigné par son identifiant
--      (`planificator.staged_erasure_id`).
-- 2. Coffre : destruction cryptographique (statut DESTROYED) d'une version REVOKED, RETIRED ou FAILED depuis plus de
--    90 jours : DEK enveloppée, nonces, étiquettes et chiffré remplacés par des zéros, indice effacé, `keyId` = destroyed.
--    Rien d'autre ne change ; une version détruite ne change plus jamais ; aucune suppression de ligne ; le journal
--    d'audit (append-only) garde la trace (`CREDENTIAL_DESTROYED`).

BEGIN;

ALTER TABLE "integration_credential_versions" ADD COLUMN "destroyedAt" TIMESTAMP(3);

ALTER TABLE "integration_credential_versions" DROP CONSTRAINT "integration_credential_versions_values_check";
ALTER TABLE "integration_credential_versions" ADD CONSTRAINT "integration_credential_versions_values_check" CHECK (
  length("credentialsRef") BETWEEN 8 AND 120
  AND "environment" IN ('production', 'preview', 'development', 'test')
  AND "secretVersion" >= 1
  AND "keyId" ~ '^[a-z0-9_]{1,32}$'
  AND "encVersion" = 1
  AND octet_length("wrappedDek") = 32
  AND octet_length("dekNonce") = 12 AND octet_length("dekTag") = 16
  AND octet_length("nonce") = 12 AND octet_length("tag") = 16
  AND octet_length("ciphertext") BETWEEN 1 AND 16384
  AND ("hint" IS NULL OR length("hint") <= 4)
  AND length(btrim("createdById")) > 0
  AND ("revokedReason" IS NULL OR length("revokedReason") BETWEEN 1 AND 60)
  AND ("status" <> 'ACTIVE' OR "activatedAt" IS NOT NULL)
  AND ("status" <> 'RETIRED' OR ("activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL))
  AND ("status" <> 'REVOKED' OR ("revokedAt" IS NOT NULL AND "revokedReason" IS NOT NULL))
  AND ("status" <> 'FAILED' OR "failedAt" IS NOT NULL)
  AND (("status" = 'DESTROYED') = ("destroyedAt" IS NOT NULL))
  AND ("status" <> 'DESTROYED' OR ("keyId" = 'destroyed' AND "hint" IS NULL
       AND "wrappedDek" = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea
       AND "dekNonce" = '\x000000000000000000000000'::bytea AND "nonce" = '\x000000000000000000000000'::bytea
       AND "dekTag" = '\x00000000000000000000000000000000'::bytea AND "tag" = '\x00000000000000000000000000000000'::bytea
       AND "ciphertext" = '\x00'::bytea))
);

ALTER TABLE "integration_secret_audit_logs" DROP CONSTRAINT "integration_secret_audit_logs_values_check";
ALTER TABLE "integration_secret_audit_logs" ADD CONSTRAINT "integration_secret_audit_logs_values_check" CHECK (
  "action" IN ('CREDENTIAL_CREATED', 'CREDENTIAL_ACTIVATED', 'CREDENTIAL_RETIRED', 'CREDENTIAL_FAILED', 'CREDENTIAL_REVOKED', 'DEK_REWRAPPED', 'RESOLUTION_DENIED', 'CREDENTIAL_DESTROYED')
  AND "outcome" IN ('SUCCESS', 'FAILURE')
  AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z_]{2,60}$')
  AND "environment" IN ('production', 'preview', 'development', 'test')
  AND length(btrim("actorId")) > 0
  AND ("credentialsRef" IS NULL OR length("credentialsRef") BETWEEN 8 AND 120)
);

-- Coffre : règles du LOT-8A inchangées, plus la seule transition de destruction ci-dessus.
CREATE OR REPLACE FUNCTION integration_credential_version_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  ended timestamp(3);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credential version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'DESTROYED' THEN
    RAISE EXCEPTION 'destroyed credential version is final' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'DESTROYED' THEN
    ended := CASE OLD."status" WHEN 'REVOKED' THEN OLD."revokedAt" WHEN 'RETIRED' THEN OLD."retiredAt" WHEN 'FAILED' THEN OLD."failedAt" END;
    IF ended IS NULL OR ended >= (now() AT TIME ZONE 'UTC') - interval '90 days' THEN
      RAISE EXCEPTION 'credential version can be destroyed only 90 days after it ended' USING ERRCODE = '23514';
    END IF;
    IF (NEW."id", NEW."companyId", NEW."connectionId", NEW."credentialsRef", NEW."secretKind", NEW."environment", NEW."secretVersion",
        NEW."encVersion", NEW."createdById", NEW."createdAt", NEW."activatedAt", NEW."retiredAt", NEW."revokedAt", NEW."revokedReason", NEW."failedAt")
       IS DISTINCT FROM
       (OLD."id", OLD."companyId", OLD."connectionId", OLD."credentialsRef", OLD."secretKind", OLD."environment", OLD."secretVersion",
        OLD."encVersion", OLD."createdById", OLD."createdAt", OLD."activatedAt", OLD."retiredAt", OLD."revokedAt", OLD."revokedReason", OLD."failedAt") THEN
      RAISE EXCEPTION 'credential destruction may only erase key material' USING ERRCODE = '23514';
    END IF;
    RETURN NEW; -- le contenu exact (zéros, indice effacé, keyId) est imposé par la contrainte CHECK
  END IF;
  IF (NEW."id", NEW."companyId", NEW."connectionId", NEW."credentialsRef", NEW."secretKind", NEW."environment", NEW."secretVersion",
      NEW."encVersion", NEW."ciphertext", NEW."nonce", NEW."tag", NEW."hint", NEW."createdById", NEW."createdAt", NEW."destroyedAt")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."connectionId", OLD."credentialsRef", OLD."secretKind", OLD."environment", OLD."secretVersion",
      OLD."encVersion", OLD."ciphertext", OLD."nonce", OLD."tag", OLD."hint", OLD."createdById", OLD."createdAt", OLD."destroyedAt") THEN
    RAISE EXCEPTION 'credential version identity and ciphertext are immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW."keyId", NEW."wrappedDek", NEW."dekNonce", NEW."dekTag") IS DISTINCT FROM (OLD."keyId", OLD."wrappedDek", OLD."dekNonce", OLD."dekTag")
     AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."keyId" = OLD."keyId") THEN
    RAISE EXCEPTION 'DEK rewrap must change keyId and nothing else' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('ACTIVE', 'FAILED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" IN ('RETIRED', 'REVOKED'))
    OR (OLD."status" = 'RETIRED' AND NEW."status" = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'credential version status transition not allowed' USING ERRCODE = '23514';
  END IF;
  IF (OLD."activatedAt" IS NOT NULL AND NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt")
     OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt")
     OR (OLD."failedAt" IS NOT NULL AND NEW."failedAt" IS DISTINCT FROM OLD."failedAt") THEN
    RAISE EXCEPTION 'credential version transition timestamps are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Zone de transit : règles du LOT-8B inchangées, plus les deux suppressions encadrées ci-dessus.
CREATE OR REPLACE FUNCTION connector_staged_record_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('planificator.staged_erasure_id', true) IS NOT DISTINCT FROM OLD."id" THEN
      RETURN OLD;
    END IF;
    IF current_setting('planificator.retention_purge', true) = 'on'
       AND OLD."updatedAt" < (now() AT TIME ZONE 'UTC') - interval '365 days' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'staged record cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "connector_settings" s
    WHERE s."companyId" = NEW."companyId" AND s."connectorKey" = NEW."connectorKey" AND s."mode" IN ('SIMULATION', 'LIVE')
  ) THEN
    RAISE EXCEPTION 'connector is not in simulation or live mode' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."companyId", NEW."connectorKey", NEW."resource", NEW."externalId", NEW."firstRunId", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."connectorKey", OLD."resource", OLD."externalId", OLD."firstRunId", OLD."createdAt") THEN
      RAISE EXCEPTION 'staged record identity immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."version" <> OLD."version" + 1 OR NEW."payloadHash" = OLD."payloadHash" THEN
      RAISE EXCEPTION 'staged record update must be a new version of a changed payload' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."version" <> 1 OR NEW."lastRunId" <> NEW."firstRunId" THEN
    RAISE EXCEPTION 'staged record must start at version 1' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
