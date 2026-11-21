-- Planificator — application manuelle de la migration 20261123090000_v2_google_calendar_live en production
-- (Neon SQL Editor, projet « planificator », branche « production », base « neondb », rôle neondb_owner).
-- Tout-ou-rien (BEGIN/COMMIT). Refuse de s'exécuter : hors de la base neondb, si la migration est déjà appliquée, ou si les
-- migrations du lot 8B (dont elle dépend) manquent. Corps identique au fichier de migration ; checksum = SHA-256 du fichier.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Mauvaise base (%) : ce script ne vise que neondb (production).', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261123090000_v2_google_calendar_live' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration 20261123090000_v2_google_calendar_live déjà appliquée : rien à faire.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261122090100_v2_connectors_live' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration préalable 20261122090100_v2_connectors_live (lot 8B) absente : appliquer d''abord le lot 8B.';
  END IF;
END $$;
UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20261123090000_v2_google_calendar_live' AND finished_at IS NULL AND rolled_back_at IS NULL;

-- 23/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-8C : Google Agenda en lecture seule (OAuth, SECURITY-SPEC §10, §11).
-- Migration ADDITIVE : une table nouvelle (états OAuth à usage unique) et la liste fermée du mode LIVE élargie à
-- google_calendar. Aucune donnée existante lue ni écrite. À appliquer avec le rôle propriétaire (docs/runbooks/DB-APP-ROLE.md).
--
-- États OAuth (§11.2) : jamais le `state` lui-même ni le cookie du navigateur, seulement leurs empreintes SHA-256 ;
-- durée de vie de 10 minutes au plus (15 en base) ; usage unique (consommation = date posée une seule fois, vérificateur
-- PKCE effacé au même instant) ; liés à la société, à l'utilisateur et au connecteur. Le vérificateur PKCE n'est utile
-- qu'avec le code d'autorisation, remis seulement à l'adresse de retour déclarée.


CREATE TABLE "integration_oauth_states" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "integration_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_oauth_states_stateHash_key" ON "integration_oauth_states"("stateHash");
CREATE INDEX "integration_oauth_states_companyId_userId_createdAt_idx" ON "integration_oauth_states"("companyId", "userId", "createdAt");

ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Contraintes (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "integration_oauth_states" ADD CONSTRAINT "integration_oauth_states_values_check" CHECK (
  "connectorKey" IN ('google_calendar')
  AND "stateHash" ~ '^[0-9a-f]{64}$'
  AND "browserHash" ~ '^[0-9a-f]{64}$'
  AND ("codeVerifier" IS NULL OR "codeVerifier" ~ '^[A-Za-z0-9_-]{43,128}$')
  AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '15 minutes'
  AND ("consumedAt" IS NULL) = ("codeVerifier" IS NOT NULL)
);

-- Usage unique : seule la consommation est permise (date posée une fois, vérificateur effacé), tout le reste est figé.
CREATE FUNCTION integration_oauth_state_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."companyId", NEW."userId", NEW."connectorKey", NEW."stateHash", NEW."browserHash", NEW."createdAt", NEW."expiresAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."userId", OLD."connectorKey", OLD."stateHash", OLD."browserHash", OLD."createdAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'oauth state immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'oauth state already consumed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_oauth_states_guard BEFORE UPDATE ON "integration_oauth_states"
  FOR EACH ROW EXECUTE FUNCTION integration_oauth_state_guard();

-- Mode LIVE : Google Agenda rejoint la liste fermée des connexions réelles.
ALTER TABLE "connector_settings" DROP CONSTRAINT "connector_settings_live_check";
ALTER TABLE "connector_settings" ADD CONSTRAINT "connector_settings_live_check" CHECK (
  "mode" <> 'LIVE' OR ("connectionId" IS NOT NULL AND "connectorKey" IN ('shopify', 'mailchimp', 'slack', 'google_calendar'))
);


INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
VALUES (gen_random_uuid()::text, '5d93c8f3a62002e038c43b23b9e2a27bc869f011c259a4dedd8858a7621fb94f', now(), '20261123090000_v2_google_calendar_live', NULL, NULL, now(), 1);
COMMIT;

-- Vérification après exécution (lecture seule) :
-- SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20261123090000_v2_google_calendar_live';
-- SELECT has_table_privilege('planificator_app', 'integration_oauth_states', 'INSERT, UPDATE, SELECT');  -- attendu : true
