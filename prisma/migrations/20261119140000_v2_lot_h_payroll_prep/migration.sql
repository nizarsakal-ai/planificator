-- Lot H Planificator V2 (05/11/2026) : pré-paie (évolution 9, périmètre réduit). Migration EXPAND, additive : 2 types
-- et 2 tables nouveaux, leurs index et clés. Aucun objet existant modifié, aucune ligne existante lue ni écrite.
-- Corps généré par `prisma migrate diff` (schéma lot G vers ce lot), puis CHECK et déclencheurs à la main en fin de
-- fichier. Module désactivé par défaut (PAYROLL_PREP_ENABLED). Aucun calcul de salaire ni de cotisation, aucune DSN
-- déposée : aucune activation de paie réelle.
-- Garanties portées par la base : une période par mois et par entreprise ; période clôturée immuable avec instantané
-- empreint ; variables saisies seulement sur une période ouverte ; jamais de suppression de période.

BEGIN;

-- CreateEnum
CREATE TYPE "PayrollPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "PayrollVariableKind" AS ENUM ('BONUS', 'EXPENSE');

-- CreateTable
CREATE TABLE "payroll_periods" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PayrollPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "snapshot" JSONB,
    "snapshotSha256" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "payroll_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_manual_variables" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "PayrollVariableKind" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "label" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_manual_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_companyId_id_key" ON "payroll_periods"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_periods_companyId_year_month_key" ON "payroll_periods"("companyId", "year", "month");

-- CreateIndex
CREATE INDEX "payroll_manual_variables_companyId_periodId_idx" ON "payroll_manual_variables"("companyId", "periodId");

-- CreateIndex
CREATE INDEX "payroll_manual_variables_employeeId_companyId_idx" ON "payroll_manual_variables"("employeeId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_manual_variables_companyId_id_key" ON "payroll_manual_variables"("companyId", "id");

-- AddForeignKey
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_manual_variables" ADD CONSTRAINT "payroll_manual_variables_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_manual_variables" ADD CONSTRAINT "payroll_manual_variables_companyId_periodId_fkey" FOREIGN KEY ("companyId", "periodId") REFERENCES "payroll_periods"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_manual_variables" ADD CONSTRAINT "payroll_manual_variables_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_values_check" CHECK (
  "year" BETWEEN 2000 AND 2100 AND "month" BETWEEN 1 AND 12
  AND length(btrim("createdById")) > 0
  AND (
    ("status" = 'OPEN' AND "snapshot" IS NULL AND "snapshotSha256" IS NULL AND "closedById" IS NULL AND "closedAt" IS NULL)
    -- Revue Codex du 05/11 : IS NOT NULL explicites (jsonb_typeof(NULL) et NULL ~ … valent NULL, que le CHECK admettrait).
    OR ("status" = 'CLOSED' AND "snapshot" IS NOT NULL AND jsonb_typeof("snapshot") = 'object'
        AND "snapshotSha256" IS NOT NULL AND "snapshotSha256" ~ '^[0-9a-f]{64}$'
        AND "closedById" IS NOT NULL AND "closedAt" IS NOT NULL)
  )
);

ALTER TABLE "payroll_manual_variables" ADD CONSTRAINT "payroll_manual_variables_values_check" CHECK (
  "amountCents" BETWEEN 1 AND 1000000000
  AND length(btrim("label")) BETWEEN 2 AND 120
  AND length(btrim("createdById")) > 0
);

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION lot_h_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lot H history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER payroll_periods_no_truncate BEFORE TRUNCATE ON "payroll_periods"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_h_no_truncate();
CREATE TRIGGER payroll_manual_variables_no_truncate BEFORE TRUNCATE ON "payroll_manual_variables"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_h_no_truncate();

-- Période : naît ouverte ; jamais supprimée ; identité figée ; seule transition OPEN → CLOSED ; clôturée = immuable.
CREATE FUNCTION payroll_period_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll period cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'payroll period must start open' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed payroll period immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."year", NEW."month", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."year", OLD."month", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'payroll period identity immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_periods_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_periods"
  FOR EACH ROW EXECUTE FUNCTION payroll_period_guard();

-- Variable saisie : création et suppression seulement sur une période OUVERTE ; jamais modifiée (supprimer puis
-- ressaisir tant que la période est ouverte).
CREATE FUNCTION payroll_variable_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  p_company TEXT;
  p_period TEXT;
  p_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payroll variable immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN p_company := OLD."companyId"; p_period := OLD."periodId"; ELSE p_company := NEW."companyId"; p_period := NEW."periodId"; END IF;
  -- Verrou partagé de la période : une clôture concurrente (verrou exclusif) attend, puis son état est relu.
  SELECT p."status"::text INTO p_status FROM "payroll_periods" p WHERE p."id" = p_period AND p."companyId" = p_company FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll period not found' USING ERRCODE = '23503';
  END IF;
  IF p_status <> 'OPEN' THEN
    RAISE EXCEPTION 'payroll period is closed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_manual_variables_guard BEFORE INSERT OR UPDATE OR DELETE ON "payroll_manual_variables"
  FOR EACH ROW EXECUTE FUNCTION payroll_variable_guard();

COMMIT;
