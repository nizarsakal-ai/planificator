-- Lot D Planificator V2 (conçu le 04/11/2026, réconcilié le 12/11/2026 sur l'arbre publié b0a2523e, après le lot C) :
-- réserves de réception et procès-verbal (évolution 11).
-- Migration EXPAND, purement additive : 4 types, 4 tables, leurs index et clés. Aucune table existante modifiée,
-- aucune ligne existante lue ni écrite. Corps généré par `prisma migrate diff` (schéma lot C vers ce lot), puis, à la
-- main en fin de fichier : contraintes CHECK et déclencheurs (procès-verbal, liens et preuves immuables ; réserve
-- jamais supprimée, transitions OPEN → LIFTED ou CANCELLED seulement, figée ensuite ; une réserve inscrite à un
-- procès-verbal ne s'annule pas ; cohérence décision / réserves contrôlée à la validation). Module désactivé par
-- défaut (WORKSITE_RESERVES_ENABLED).
-- Réconciliation 12/11 : aucune clé vers « employees » (responsable = libellé libre « assigneeLabel », module RH non
-- touché) ; un procès-verbal inscrit au plus 500 réserves (au-delà, la signature est refusée, jamais tronquée).
-- Application CIBLÉE uniquement, jamais de « migrate deploy » global. Dépend des migrations des lots A, B et C
-- (aucune de leurs tables n'est modifiée).

BEGIN;

CREATE TYPE "ReserveSeverity" AS ENUM ('MINOR', 'MAJOR', 'BLOCKING');

CREATE TYPE "ReserveStatus" AS ENUM ('OPEN', 'LIFTED', 'CANCELLED');

CREATE TYPE "ReserveFileKind" AS ENUM ('FINDING', 'LIFT');

CREATE TYPE "ReceptionDecision" AS ENUM ('WITHOUT_RESERVES', 'WITH_RESERVES', 'REFUSED');

CREATE TABLE "worksite_reserves" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT NOT NULL,
    "severity" "ReserveSeverity" NOT NULL DEFAULT 'MINOR',
    "status" "ReserveStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeLabel" TEXT,
    "dueDate" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "worksite_reserves_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "worksite_reserve_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reserveId" TEXT NOT NULL,
    "kind" "ReserveFileKind" NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "originalName" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worksite_reserve_files_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reception_reports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "decision" "ReceptionDecision" NOT NULL,
    "receptionDate" DATE NOT NULL,
    "clientSignerName" TEXT NOT NULL,
    "companySignerName" TEXT NOT NULL,
    "attendees" TEXT,
    "remarks" TEXT,
    "signatureSha256" TEXT NOT NULL,
    "signaturePng" BYTEA NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotSha256" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reception_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reception_report_reserves" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "reserveId" TEXT NOT NULL,

    CONSTRAINT "reception_report_reserves_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worksite_reserves_companyId_worksiteId_status_idx" ON "worksite_reserves"("companyId", "worksiteId", "status");

CREATE UNIQUE INDEX "worksite_reserves_companyId_id_key" ON "worksite_reserves"("companyId", "id");

CREATE UNIQUE INDEX "worksite_reserves_companyId_number_key" ON "worksite_reserves"("companyId", "number");

CREATE INDEX "worksite_reserve_files_companyId_reserveId_idx" ON "worksite_reserve_files"("companyId", "reserveId");

CREATE UNIQUE INDEX "worksite_reserve_files_companyId_id_key" ON "worksite_reserve_files"("companyId", "id");

CREATE INDEX "reception_reports_companyId_worksiteId_idx" ON "reception_reports"("companyId", "worksiteId");

CREATE UNIQUE INDEX "reception_reports_companyId_id_key" ON "reception_reports"("companyId", "id");

CREATE UNIQUE INDEX "reception_reports_companyId_number_key" ON "reception_reports"("companyId", "number");

CREATE INDEX "reception_report_reserves_companyId_reserveId_idx" ON "reception_report_reserves"("companyId", "reserveId");

CREATE UNIQUE INDEX "reception_report_reserves_companyId_id_key" ON "reception_report_reserves"("companyId", "id");

CREATE UNIQUE INDEX "reception_report_reserves_reportId_reserveId_key" ON "reception_report_reserves"("reportId", "reserveId");

ALTER TABLE "worksite_reserves" ADD CONSTRAINT "worksite_reserves_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_reserves" ADD CONSTRAINT "worksite_reserves_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_reserve_files" ADD CONSTRAINT "worksite_reserve_files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_reserve_files" ADD CONSTRAINT "worksite_reserve_files_companyId_reserveId_fkey" FOREIGN KEY ("companyId", "reserveId") REFERENCES "worksite_reserves"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reception_reports" ADD CONSTRAINT "reception_reports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reception_reports" ADD CONSTRAINT "reception_reports_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reception_report_reserves" ADD CONSTRAINT "reception_report_reserves_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reception_report_reserves" ADD CONSTRAINT "reception_report_reserves_companyId_reportId_fkey" FOREIGN KEY ("companyId", "reportId") REFERENCES "reception_reports"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reception_report_reserves" ADD CONSTRAINT "reception_report_reserves_companyId_reserveId_fkey" FOREIGN KEY ("companyId", "reserveId") REFERENCES "worksite_reserves"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "worksite_reserves" ADD CONSTRAINT "worksite_reserves_values_check" CHECK (
  length(btrim("title")) BETWEEN 3 AND 200
  AND length(btrim("location")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 4000)
  AND ("liftNote" IS NULL OR length("liftNote") <= 2000)
  AND ("cancelReason" IS NULL OR length("cancelReason") <= 500)
  AND ("assigneeLabel" IS NULL OR length(btrim("assigneeLabel")) BETWEEN 1 AND 120)
  AND length(btrim("createdById")) > 0
  AND (
    ("status" = 'OPEN' AND "liftedAt" IS NULL AND "liftedById" IS NULL AND "liftNote" IS NULL
      AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
    OR ("status" = 'LIFTED' AND "liftedAt" IS NOT NULL AND "liftedById" IS NOT NULL
      AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
    OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL
      AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 3
      AND "liftedAt" IS NULL AND "liftedById" IS NULL AND "liftNote" IS NULL)
  )
);

ALTER TABLE "worksite_reserve_files" ADD CONSTRAINT "worksite_reserve_files_values_check" CHECK (
  "size" BETWEEN 1 AND 5000000
  AND octet_length("data") = "size"
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND "mime" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  AND length("originalName") BETWEEN 1 AND 200
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "reception_reports" ADD CONSTRAINT "reception_reports_values_check" CHECK (
  length(btrim("clientSignerName")) BETWEEN 2 AND 120
  AND length(btrim("companySignerName")) BETWEEN 2 AND 120
  AND ("attendees" IS NULL OR length("attendees") <= 1000)
  AND ("remarks" IS NULL OR length("remarks") <= 4000)
  AND "signatureSha256" ~ '^[0-9a-f]{64}$'
  AND "snapshotSha256" ~ '^[0-9a-f]{64}$'
  AND octet_length("signaturePng") BETWEEN 100 AND 300000
  AND length(btrim("createdById")) > 0
);

-- ── Immuabilité (ajouts manuels) ─────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION reception_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reception history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER reception_reports_immutable BEFORE UPDATE OR DELETE ON "reception_reports"
  FOR EACH ROW EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER reception_reports_no_truncate BEFORE TRUNCATE ON "reception_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER reception_report_reserves_immutable BEFORE UPDATE OR DELETE ON "reception_report_reserves"
  FOR EACH ROW EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER reception_report_reserves_no_truncate BEFORE TRUNCATE ON "reception_report_reserves"
  FOR EACH STATEMENT EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER worksite_reserve_files_immutable BEFORE UPDATE OR DELETE ON "worksite_reserve_files"
  FOR EACH ROW EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER worksite_reserve_files_no_truncate BEFORE TRUNCATE ON "worksite_reserve_files"
  FOR EACH STATEMENT EXECUTE FUNCTION reception_history_immutable();
CREATE TRIGGER worksite_reserves_no_truncate BEFORE TRUNCATE ON "worksite_reserves"
  FOR EACH STATEMENT EXECUTE FUNCTION reception_history_immutable();

-- Réserve : jamais supprimée ; identité figée ; seules transitions OPEN → LIFTED et OPEN → CANCELLED ; une réserve levée
-- ou annulée n'est plus modifiable ; une réserve inscrite à un procès-verbal ne s'annule pas (elle se lève).
CREATE FUNCTION worksite_reserve_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worksite reserve cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."worksiteId", NEW."number", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."worksiteId", OLD."number", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'worksite reserve identity immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'closed worksite reserve immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM "reception_report_reserves" r WHERE r."reserveId" = OLD."id" AND r."companyId" = OLD."companyId"
  ) THEN
    RAISE EXCEPTION 'reserve listed in a reception report cannot be cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worksite_reserves_guard BEFORE UPDATE OR DELETE ON "worksite_reserves"
  FOR EACH ROW EXECUTE FUNCTION worksite_reserve_guard();

-- Lien procès-verbal / réserve : même chantier, réserve OUVERTE au moment de l'inscription.
CREATE FUNCTION reception_report_reserve_check() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "reception_reports" p JOIN "worksite_reserves" w ON w."companyId" = p."companyId" AND w."worksiteId" = p."worksiteId"
    WHERE p."id" = NEW."reportId" AND p."companyId" = NEW."companyId" AND w."id" = NEW."reserveId" AND w."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'reception report reserve must be an open reserve of the same worksite' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reception_report_reserves_check BEFORE INSERT ON "reception_report_reserves"
  FOR EACH ROW EXECUTE FUNCTION reception_report_reserve_check();

-- Décision et réserves, contrôlées à la validation : « sans réserves » ⇒ aucune réserve inscrite ; « avec réserves »
-- ⇒ au moins une ; dans tous les cas, TOUTES les réserves ouvertes du chantier à la signature sont inscrites ;
-- au plus 500 réserves par procès-verbal (le service refuse avant toute écriture ; ce contrôle est une défense en profondeur).
CREATE FUNCTION reception_report_consistent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  listed INTEGER;
  open_not_listed INTEGER;
BEGIN
  SELECT count(*) INTO listed FROM "reception_report_reserves" WHERE "reportId" = NEW."id" AND "companyId" = NEW."companyId";
  SELECT count(*) INTO open_not_listed FROM "worksite_reserves" w
    WHERE w."companyId" = NEW."companyId" AND w."worksiteId" = NEW."worksiteId" AND w."status" = 'OPEN'
      AND NOT EXISTS (SELECT 1 FROM "reception_report_reserves" r WHERE r."reportId" = NEW."id" AND r."reserveId" = w."id");
  IF NEW."decision" = 'WITHOUT_RESERVES' AND listed <> 0 THEN
    RAISE EXCEPTION 'reception without reserves cannot list reserves' USING ERRCODE = '23514';
  END IF;
  IF NEW."decision" = 'WITH_RESERVES' AND listed = 0 THEN
    RAISE EXCEPTION 'reception with reserves must list at least one reserve' USING ERRCODE = '23514';
  END IF;
  IF listed > 500 THEN
    RAISE EXCEPTION 'reception report cannot list more than 500 reserves' USING ERRCODE = '23514';
  END IF;
  IF open_not_listed <> 0 THEN
    RAISE EXCEPTION 'reception report must list every open reserve of the worksite' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reception_reports_consistent AFTER INSERT ON "reception_reports"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reception_report_consistent();

COMMIT;
