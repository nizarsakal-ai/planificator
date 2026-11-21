-- 21/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-8A : coffre à secrets PLATFORM_ENCRYPTED
-- (docs/integration-platform-001-lot-8-secret-provider-live-connectors.plan.md ; SECURITY-SPEC §5 à §12, §18).
-- Migration ADDITIVE : deux tables neuves, aucune donnée existante modifiée. À appliquer avec le rôle propriétaire
-- (docs/runbooks/DB-APP-ROLE.md) ; les privilèges par défaut donnent au rôle applicatif ses droits DML.

-- CreateEnum
CREATE TYPE "IntegrationCredentialVersionStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED', 'RETIRED', 'FAILED', 'DESTROYED');

-- CreateEnum
CREATE TYPE "IntegrationSecretKind" AS ENUM ('API_KEY', 'OAUTH_REFRESH_TOKEN', 'CONNECTOR_OTHER');

-- CreateTable
CREATE TABLE "integration_credential_versions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "credentialsRef" TEXT NOT NULL,
    "secretKind" "IntegrationSecretKind" NOT NULL,
    "environment" TEXT NOT NULL,
    "secretVersion" INTEGER NOT NULL,
    "status" "IntegrationCredentialVersionStatus" NOT NULL DEFAULT 'PENDING',
    "keyId" TEXT NOT NULL,
    "encVersion" INTEGER NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "dekNonce" BYTEA NOT NULL,
    "dekTag" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "hint" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "integration_credential_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_secret_audit_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "credentialsRef" TEXT,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT,
    "secretVersion" INTEGER,
    "environment" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_secret_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_credential_versions_companyId_connectionId_idx" ON "integration_credential_versions"("companyId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credential_versions_companyId_id_key" ON "integration_credential_versions"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credential_versions_companyId_credentialsRef_se_key" ON "integration_credential_versions"("companyId", "credentialsRef", "secretVersion");

-- CreateIndex
CREATE INDEX "integration_secret_audit_logs_companyId_connectionId_create_idx" ON "integration_secret_audit_logs"("companyId", "connectionId", "createdAt");

-- AddForeignKey
ALTER TABLE "integration_credential_versions" ADD CONSTRAINT "integration_credential_versions_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "integration_connections"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Contrôles de forme (ajouts manuels) ─────────────────────────────────────────────────────────────────────────
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
);

-- §8 : au plus UNE version ACTIVE par handle (companyId, credentialsRef).
CREATE UNIQUE INDEX "integration_credential_versions_one_active_key"
  ON "integration_credential_versions"("companyId", "credentialsRef") WHERE "status" = 'ACTIVE';

ALTER TABLE "integration_secret_audit_logs" ADD CONSTRAINT "integration_secret_audit_logs_values_check" CHECK (
  "action" IN ('CREDENTIAL_CREATED', 'CREDENTIAL_ACTIVATED', 'CREDENTIAL_RETIRED', 'CREDENTIAL_FAILED', 'CREDENTIAL_REVOKED', 'DEK_REWRAPPED', 'RESOLUTION_DENIED')
  AND "outcome" IN ('SUCCESS', 'FAILURE')
  AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z_]{2,60}$')
  AND "environment" IN ('production', 'preview', 'development', 'test')
  AND length(btrim("actorId")) > 0
  AND ("credentialsRef" IS NULL OR length("credentialsRef") BETWEEN 8 AND 120)
);

-- ── Déclencheurs (ajouts manuels) ───────────────────────────────────────────────────────────────────────────────
-- Création : la connexion de la même société doit être sous PLATFORM_ENCRYPTED et porter ce handle (§7, §14) ;
-- toute version naît PENDING (promotion seulement après validation, §8).
CREATE FUNCTION integration_credential_version_insert_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "integration_connections" c
    WHERE c."id" = NEW."connectionId" AND c."companyId" = NEW."companyId"
      AND c."secretBackend" = 'PLATFORM_ENCRYPTED' AND c."credentialsRef" = NEW."credentialsRef"
  ) THEN
    RAISE EXCEPTION 'credential version requires a PLATFORM_ENCRYPTED connection carrying this credentialsRef' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'PENDING' OR NEW."activatedAt" IS NOT NULL OR NEW."retiredAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL OR NEW."failedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'credential version must be created PENDING' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_credential_versions_insert_guard BEFORE INSERT ON "integration_credential_versions"
  FOR EACH ROW EXECUTE FUNCTION integration_credential_version_insert_guard();

-- Mise à jour : identité et matériel chiffré immuables (sauf réenveloppement de la DEK par une nouvelle KEK, §6.2) ;
-- graphe d'états fermé (§8) ; aucune suppression.
CREATE FUNCTION integration_credential_version_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credential version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."connectionId", NEW."credentialsRef", NEW."secretKind", NEW."environment", NEW."secretVersion",
      NEW."encVersion", NEW."ciphertext", NEW."nonce", NEW."tag", NEW."hint", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."companyId", OLD."connectionId", OLD."credentialsRef", OLD."secretKind", OLD."environment", OLD."secretVersion",
      OLD."encVersion", OLD."ciphertext", OLD."nonce", OLD."tag", OLD."hint", OLD."createdById", OLD."createdAt") THEN
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
CREATE TRIGGER integration_credential_versions_update_guard BEFORE UPDATE OR DELETE ON "integration_credential_versions"
  FOR EACH ROW EXECUTE FUNCTION integration_credential_version_update_guard();

CREATE FUNCTION integration_secret_store_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration secret store cannot be truncated' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER integration_credential_versions_no_truncate BEFORE TRUNCATE ON "integration_credential_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION integration_secret_store_no_truncate();

-- Journal d'audit en ajout seul (§18.1).
CREATE FUNCTION integration_secret_audit_log_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration secret audit log is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER integration_secret_audit_logs_immutable BEFORE UPDATE OR DELETE ON "integration_secret_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION integration_secret_audit_log_immutable();
CREATE TRIGGER integration_secret_audit_logs_no_truncate BEFORE TRUNCATE ON "integration_secret_audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION integration_secret_store_no_truncate();

-- §7 : handle stable — une fois attribué, `credentialsRef` ne change plus ; §13 : `secretBackend` ne change plus dès
-- qu'une version de secret existe pour la connexion (changement de backend = procédure dédiée avec step-up).
CREATE FUNCTION integration_connection_credentials_ref_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."credentialsRef" IS NOT NULL AND NEW."credentialsRef" IS DISTINCT FROM OLD."credentialsRef" THEN
    RAISE EXCEPTION 'credentialsRef is immutable once assigned' USING ERRCODE = '23514';
  END IF;
  IF NEW."secretBackend" IS DISTINCT FROM OLD."secretBackend" AND EXISTS (
    SELECT 1 FROM "integration_credential_versions" v WHERE v."companyId" = OLD."companyId" AND v."connectionId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'secretBackend cannot change while credential versions exist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_connections_credentials_ref_guard BEFORE UPDATE ON "integration_connections"
  FOR EACH ROW EXECUTE FUNCTION integration_connection_credentials_ref_guard();
