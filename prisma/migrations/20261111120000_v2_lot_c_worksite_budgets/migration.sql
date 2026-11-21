-- Lot C Planificator V2 (04/11/2026) : budgets et marges chantier (budget par chantier, versions immuables avec
-- montants par nature, imputation explicite de factures fournisseurs à un chantier).
-- Migration EXPAND, purement additive : 2 types, 4 tables, leurs index et clés. Aucune table existante modifiée,
-- aucune ligne existante lue ni écrite. Corps généré par `prisma migrate diff` (schéma lot B vers ce lot), puis, à la
-- main en fin de fichier : contraintes CHECK de défense en profondeur et déclencheurs d'IMMUABILITÉ (une révision
-- n'efface ni ne réécrit jamais l'historique). Module désactivé par défaut (WORKSITE_BUDGET_ENABLED).
-- Dépend des migrations des lots A et B (aucune de leurs tables n'est modifiée).

BEGIN;

CREATE TYPE "WorksiteCostNature" AS ENUM ('MATERIALS', 'SUBCONTRACTING', 'EQUIPMENT', 'VEHICLES', 'LABOR', 'OTHER');

CREATE TYPE "WorksiteBudgetRevisionKind" AS ENUM ('INITIAL', 'REVISED');

CREATE TABLE "worksite_budgets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worksite_budgets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "worksite_budget_revisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "WorksiteBudgetRevisionKind" NOT NULL,
    "reason" TEXT,
    "plannedRevenueCents" BIGINT NOT NULL,
    "totalCostCents" BIGINT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worksite_budget_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "worksite_budget_lines" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "nature" "WorksiteCostNature" NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "label" TEXT,

    CONSTRAINT "worksite_budget_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_invoice_allocations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierInvoiceId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "nature" "WorksiteCostNature" NOT NULL,
    "amountHTCents" BIGINT NOT NULL,
    "label" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,

    CONSTRAINT "supplier_invoice_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "worksite_budgets_companyId_id_key" ON "worksite_budgets"("companyId", "id");

CREATE UNIQUE INDEX "worksite_budgets_worksiteId_companyId_key" ON "worksite_budgets"("worksiteId", "companyId");

CREATE UNIQUE INDEX "worksite_budget_revisions_companyId_id_key" ON "worksite_budget_revisions"("companyId", "id");

CREATE UNIQUE INDEX "worksite_budget_revisions_budgetId_number_key" ON "worksite_budget_revisions"("budgetId", "number");

CREATE UNIQUE INDEX "worksite_budget_lines_companyId_id_key" ON "worksite_budget_lines"("companyId", "id");

CREATE UNIQUE INDEX "worksite_budget_lines_revisionId_nature_key" ON "worksite_budget_lines"("revisionId", "nature");

CREATE INDEX "supplier_invoice_allocations_companyId_worksiteId_idx" ON "supplier_invoice_allocations"("companyId", "worksiteId");

CREATE INDEX "supplier_invoice_allocations_companyId_supplierInvoiceId_idx" ON "supplier_invoice_allocations"("companyId", "supplierInvoiceId");

CREATE UNIQUE INDEX "supplier_invoice_allocations_companyId_id_key" ON "supplier_invoice_allocations"("companyId", "id");

ALTER TABLE "worksite_budgets" ADD CONSTRAINT "worksite_budgets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_budgets" ADD CONSTRAINT "worksite_budgets_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_budget_revisions" ADD CONSTRAINT "worksite_budget_revisions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_budget_revisions" ADD CONSTRAINT "worksite_budget_revisions_companyId_budgetId_fkey" FOREIGN KEY ("companyId", "budgetId") REFERENCES "worksite_budgets"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_budget_lines" ADD CONSTRAINT "worksite_budget_lines_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worksite_budget_lines" ADD CONSTRAINT "worksite_budget_lines_companyId_revisionId_fkey" FOREIGN KEY ("companyId", "revisionId") REFERENCES "worksite_budget_revisions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_invoice_allocations" ADD CONSTRAINT "supplier_invoice_allocations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_invoice_allocations" ADD CONSTRAINT "supplier_invoice_allocations_companyId_supplierInvoiceId_fkey" FOREIGN KEY ("companyId", "supplierInvoiceId") REFERENCES "supplier_invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supplier_invoice_allocations" ADD CONSTRAINT "supplier_invoice_allocations_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────
-- Bornes : montants en centimes, positifs, au plus 10^13 (100 milliards d'euros).

ALTER TABLE "worksite_budgets" ADD CONSTRAINT "worksite_budgets_values_check" CHECK (
  "currentRevision" >= 0
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "worksite_budget_revisions" ADD CONSTRAINT "worksite_budget_revisions_values_check" CHECK (
  "number" >= 1
  AND (("kind" = 'INITIAL') = ("number" = 1))
  AND ("reason" IS NULL OR length("reason") <= 500)
  AND ("kind" = 'INITIAL' OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 3))
  AND "plannedRevenueCents" BETWEEN 0 AND 10000000000000
  AND "totalCostCents" BETWEEN 0 AND 10000000000000
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "worksite_budget_lines" ADD CONSTRAINT "worksite_budget_lines_values_check" CHECK (
  "amountCents" BETWEEN 0 AND 10000000000000
  AND ("label" IS NULL OR length("label") <= 200)
);

ALTER TABLE "supplier_invoice_allocations" ADD CONSTRAINT "supplier_invoice_allocations_values_check" CHECK (
  "amountHTCents" BETWEEN 1 AND 10000000000000
  AND ("label" IS NULL OR length("label") <= 200)
  AND length(btrim("createdById")) > 0
  AND (("cancelledAt" IS NULL) = ("cancelledById" IS NULL))
);

-- ── Immuabilité (ajouts manuels) ─────────────────────────────────────────────────────────────────────────────────
-- Versions et lignes de budget : ni modification, ni suppression, ni vidage de table.
CREATE FUNCTION worksite_budget_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'worksite budget history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER worksite_budget_revisions_immutable BEFORE UPDATE OR DELETE ON "worksite_budget_revisions"
  FOR EACH ROW EXECUTE FUNCTION worksite_budget_history_immutable();
CREATE TRIGGER worksite_budget_revisions_no_truncate BEFORE TRUNCATE ON "worksite_budget_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION worksite_budget_history_immutable();
CREATE TRIGGER worksite_budget_lines_immutable BEFORE UPDATE OR DELETE ON "worksite_budget_lines"
  FOR EACH ROW EXECUTE FUNCTION worksite_budget_history_immutable();
CREATE TRIGGER worksite_budget_lines_no_truncate BEFORE TRUNCATE ON "worksite_budget_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION worksite_budget_history_immutable();
-- Revue indépendante v1 (P1, intégration 35c0f227) : une ligne ne peut être AJOUTÉE qu'à une version créée par la MÊME
-- transaction (xmin de la version = identifiant de la transaction courante, 32 bits bas de pg_current_xact_id()). Une version
-- déjà validée, ou créée par une autre transaction encore ouverte (invisible ici), refuse toute ligne nouvelle, quelle que
-- soit sa nature (absente comprise) ou son montant (zéro compris). La création légitime (version + lignes dans une seule
-- transaction, comme le service) reste admise ; la somme est recontrôlée à la validation (déclencheur différé ci-dessous).
-- Limite assumée : la version et ses lignes doivent être écrites au niveau principal de la transaction (sans SAVEPOINT).
CREATE FUNCTION worksite_budget_line_insert_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  revision_xmin TEXT;
BEGIN
  SELECT xmin::text INTO revision_xmin FROM "worksite_budget_revisions" WHERE "id" = NEW."revisionId" AND "companyId" = NEW."companyId";
  IF revision_xmin IS NULL OR revision_xmin <> (pg_current_xact_id()::text::numeric % 4294967296)::text THEN
    RAISE EXCEPTION 'worksite budget history immutable: lines can only be added with their own revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worksite_budget_lines_insert_guard BEFORE INSERT ON "worksite_budget_lines"
  FOR EACH ROW EXECUTE FUNCTION worksite_budget_line_insert_guard();

-- Budget : jamais supprimé ; seule évolution admise = version courante + 1 (identité figée).
CREATE FUNCTION worksite_budget_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'worksite budget cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."worksiteId", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."worksiteId", OLD."createdById", OLD."createdAt")
     OR NEW."currentRevision" <> OLD."currentRevision" + 1 THEN
    RAISE EXCEPTION 'worksite budget: only currentRevision + 1 is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worksite_budgets_guard BEFORE UPDATE OR DELETE ON "worksite_budgets"
  FOR EACH ROW EXECUTE FUNCTION worksite_budget_guard();
CREATE TRIGGER worksite_budgets_no_truncate BEFORE TRUNCATE ON "worksite_budgets"
  FOR EACH STATEMENT EXECUTE FUNCTION worksite_budget_history_immutable();

-- Cohérence d'une version, contrôlée à la validation de la transaction : total = somme des lignes, et la version est
-- devenue la version courante du budget (ou une version antérieure).
CREATE FUNCTION worksite_budget_revision_consistent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  line_total NUMERIC;
  current_rev INTEGER;
BEGIN
  SELECT COALESCE(SUM("amountCents"), 0) INTO line_total FROM "worksite_budget_lines" WHERE "revisionId" = NEW."id";
  SELECT "currentRevision" INTO current_rev FROM "worksite_budgets" WHERE "id" = NEW."budgetId" AND "companyId" = NEW."companyId";
  IF line_total <> NEW."totalCostCents" THEN
    RAISE EXCEPTION 'worksite budget revision total differs from its lines' USING ERRCODE = '23514';
  END IF;
  IF current_rev IS NULL OR current_rev < NEW."number" THEN
    RAISE EXCEPTION 'worksite budget revision is not recorded on its budget' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER worksite_budget_revisions_consistent AFTER INSERT ON "worksite_budget_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION worksite_budget_revision_consistent();

-- Revue indépendante C-R1 (v3) : un budget ne peut désigner comme courante qu'une version ENREGISTRÉE. Contrôlé à la
-- validation de la transaction (différé : le service insère la version puis avance currentRevision, dans un ordre libre) :
-- currentRevision = 0 (budget sans version), ou une version de ce budget porte exactement ce numéro. Un avancement
-- « currentRevision + 1 » sans version correspondante, ou un budget inséré avec une version courante fictive, est refusé.
CREATE FUNCTION worksite_budget_current_recorded() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currentRevision" <> 0 AND NOT EXISTS (
    SELECT 1 FROM "worksite_budget_revisions"
    WHERE "budgetId" = NEW."id" AND "companyId" = NEW."companyId" AND "number" = NEW."currentRevision"
  ) THEN
    RAISE EXCEPTION 'worksite budget current revision has no matching revision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER worksite_budgets_current_recorded AFTER INSERT OR UPDATE ON "worksite_budgets"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION worksite_budget_current_recorded();

-- Imputation de facture fournisseur : jamais supprimée ; seule évolution admise = annulation (une fois).
CREATE FUNCTION supplier_invoice_allocation_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier invoice allocation cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL OR NEW."cancelledAt" IS NULL
     OR (NEW."id", NEW."companyId", NEW."supplierInvoiceId", NEW."worksiteId", NEW."nature", NEW."amountHTCents", NEW."label", NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."supplierInvoiceId", OLD."worksiteId", OLD."nature", OLD."amountHTCents", OLD."label", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'supplier invoice allocation: only a single cancellation is allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_invoice_allocations_guard BEFORE UPDATE OR DELETE ON "supplier_invoice_allocations"
  FOR EACH ROW EXECUTE FUNCTION supplier_invoice_allocation_guard();
CREATE TRIGGER supplier_invoice_allocations_no_truncate BEFORE TRUNCATE ON "supplier_invoice_allocations"
  FOR EACH STATEMENT EXECUTE FUNCTION worksite_budget_history_immutable();

COMMIT;
