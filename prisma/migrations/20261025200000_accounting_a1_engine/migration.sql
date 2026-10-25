-- CreateEnum
CREATE TYPE "FiscalYearStatus" AS ENUM ('OPEN', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalEntryStatus" AS ENUM ('DRAFT', 'VALIDATED');

-- CreateEnum
CREATE TYPE "AccountingJournalKind" AS ENUM ('SALES', 'PURCHASES', 'BANK', 'MISC');

-- CreateTable
CREATE TABLE "accounting_accounts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_journals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "AccountingJournalKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_sequences" (
    "companyId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "accounting_sequences_pkey" PRIMARY KEY ("companyId","journalId","fiscalYearId")
);

-- CreateTable
CREATE TABLE "accounting_chain_heads" (
    "companyId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "lastEntryId" TEXT,
    "lastHash" TEXT NOT NULL,

    CONSTRAINT "accounting_chain_heads_pkey" PRIMARY KEY ("companyId","journalId")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "status" "JournalEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "entryDate" DATE NOT NULL,
    "documentDate" DATE,
    "documentRef" TEXT,
    "label" TEXT NOT NULL,
    "closingEntry" BOOLEAN NOT NULL DEFAULT false,
    "number" INTEGER,
    "validatedAt" TIMESTAMP(3),
    "validatedById" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceVersion" INTEGER,
    "sourceHash" TEXT,
    "reversalOfId" TEXT,
    "prevEntryId" TEXT,
    "prevHash" TEXT,
    "hash" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry_lines" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT,
    "debitCents" BIGINT NOT NULL DEFAULT 0,
    "creditCents" BIGINT NOT NULL DEFAULT 0,
    "vatRateBp" INTEGER,

    CONSTRAINT "journal_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_accounts_companyId_number_key" ON "accounting_accounts"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_accounts_companyId_id_key" ON "accounting_accounts"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_journals_companyId_code_key" ON "accounting_journals"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_journals_companyId_id_key" ON "accounting_journals"("companyId", "id");

-- CreateIndex
CREATE INDEX "fiscal_years_companyId_startDate_idx" ON "fiscal_years"("companyId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_companyId_id_key" ON "fiscal_years"("companyId", "id");

-- CreateIndex
CREATE INDEX "journal_entries_companyId_status_idx" ON "journal_entries"("companyId", "status");

-- CreateIndex
CREATE INDEX "journal_entries_companyId_fiscalYearId_idx" ON "journal_entries"("companyId", "fiscalYearId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_id_key" ON "journal_entries"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_journalId_fiscalYearId_number_key" ON "journal_entries"("companyId", "journalId", "fiscalYearId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_sourceType_sourceId_sourceVersion_key" ON "journal_entries"("companyId", "sourceType", "sourceId", "sourceVersion");

-- CreateIndex
CREATE INDEX "journal_entry_lines_companyId_accountId_idx" ON "journal_entry_lines"("companyId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entry_lines_entryId_position_key" ON "journal_entry_lines"("entryId", "position");

-- AddForeignKey
ALTER TABLE "accounting_accounts" ADD CONSTRAINT "accounting_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_journals" ADD CONSTRAINT "accounting_journals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_sequences" ADD CONSTRAINT "accounting_sequences_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_sequences" ADD CONSTRAINT "accounting_sequences_companyId_journalId_fkey" FOREIGN KEY ("companyId", "journalId") REFERENCES "accounting_journals"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_sequences" ADD CONSTRAINT "accounting_sequences_companyId_fiscalYearId_fkey" FOREIGN KEY ("companyId", "fiscalYearId") REFERENCES "fiscal_years"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_chain_heads" ADD CONSTRAINT "accounting_chain_heads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_chain_heads" ADD CONSTRAINT "accounting_chain_heads_companyId_journalId_fkey" FOREIGN KEY ("companyId", "journalId") REFERENCES "accounting_journals"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_companyId_journalId_fkey" FOREIGN KEY ("companyId", "journalId") REFERENCES "accounting_journals"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_companyId_fiscalYearId_fkey" FOREIGN KEY ("companyId", "fiscalYearId") REFERENCES "fiscal_years"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_companyId_reversalOfId_fkey" FOREIGN KEY ("companyId", "reversalOfId") REFERENCES "journal_entries"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_companyId_entryId_fkey" FOREIGN KEY ("companyId", "entryId") REFERENCES "journal_entries"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_companyId_accountId_fkey" FOREIGN KEY ("companyId", "accountId") REFERENCES "accounting_accounts"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Lot A1 — garanties en base (ADR-PLAN-003 §3-§8, SPEC-ACC-A §2-§3 bis)
-- ═══════════════════════════════════════════════════════════════════════════

-- Lignes : débit XOR crédit, positifs, bornés.
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "jel_amounts_ck"
  CHECK ("debitCents" >= 0 AND "creditCents" >= 0
     AND ("debitCents" > 0) <> ("creditCents" > 0)
     AND "debitCents" <= 1000000000000000 AND "creditCents" <= 1000000000000000);
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "jel_vat_ck" CHECK ("vatRateBp" IS NULL OR ("vatRateBp" >= 0 AND "vatRateBp" <= 10000));
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "jel_position_ck" CHECK ("position" >= 0);

-- Écritures : champs source tout-ou-rien ; état cohérent.
ALTER TABLE "journal_entries" ADD CONSTRAINT "je_source_ck"
  CHECK (("sourceType" IS NULL AND "sourceId" IS NULL AND "sourceVersion" IS NULL AND "sourceHash" IS NULL)
      OR ("sourceType" IS NOT NULL AND "sourceId" IS NOT NULL AND "sourceVersion" IS NOT NULL AND "sourceHash" IS NOT NULL));
ALTER TABLE "journal_entries" ADD CONSTRAINT "je_state_ck"
  CHECK (("status" = 'DRAFT' AND "number" IS NULL AND "validatedAt" IS NULL AND "validatedById" IS NULL AND "hash" IS NULL AND "prevHash" IS NULL AND "prevEntryId" IS NULL)
      OR ("status" = 'VALIDATED' AND "number" IS NOT NULL AND "number" > 0 AND "validatedAt" IS NOT NULL AND "validatedById" IS NOT NULL AND "hash" IS NOT NULL AND "prevHash" IS NOT NULL));
CREATE UNIQUE INDEX "je_one_reversal_per_entry" ON "journal_entries"("reversalOfId") WHERE "reversalOfId" IS NOT NULL;
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fy_dates_ck" CHECK ("endDate" > "startDate");
ALTER TABLE "accounting_sequences" ADD CONSTRAINT "seq_positive_ck" CHECK ("lastNumber" >= 0);

-- Chaînage : au plus un successeur par écriture, une seule origine (genesis) validée par journal.
CREATE UNIQUE INDEX "je_one_successor" ON "journal_entries"("companyId", "journalId", "prevEntryId") WHERE "prevEntryId" IS NOT NULL;
CREATE UNIQUE INDEX "je_one_genesis" ON "journal_entries"("companyId", "journalId") WHERE "status" = 'VALIDATED' AND "prevEntryId" IS NULL;

-- Contexte moteur. L'indicateur seul n'est PAS une autorisation (tout rôle peut appeler set_config) :
-- il faut en plus s'exécuter sous le propriétaire des tables, ce qui n'est possible pour le rôle applicatif
-- qu'à travers les fonctions SECURITY DEFINER ci-dessous (accounting_post_entry, accounting_advance_fiscal_year).
-- Prérequis de déploiement : le rôle applicatif n'est pas propriétaire des tables comptables.
CREATE OR REPLACE FUNCTION accounting_engine_context() RETURNS boolean AS $$
  SELECT coalesce(current_setting('planificator.accounting_engine', true), '') = 'on'
     AND current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'journal_entries'::regclass)
$$ LANGUAGE sql STABLE;

-- Forme canonique v1 (identique à src/lib/accounting/engine/canonical.ts) : clés triées, aucun espace,
-- chaînes NFC échappées comme JSON.stringify, dates ISO, horodatage UTC à la seconde, montants en chaînes.
CREATE OR REPLACE FUNCTION accounting_json_text(t text) RETURNS text AS $$
  SELECT CASE WHEN t IS NULL THEN 'null' ELSE to_json(normalize(t, NFC))::text END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION accounting_entry_canonical(e "journal_entries") RETURNS text AS $$
  SELECT '{'
    || '"closingEntry":' || CASE WHEN e."closingEntry" THEN 'true' ELSE 'false' END
    || ',"companyId":' || accounting_json_text(e."companyId")
    || ',"documentDate":' || CASE WHEN e."documentDate" IS NULL THEN 'null' ELSE '"' || to_char(e."documentDate", 'YYYY-MM-DD') || '"' END
    || ',"documentRef":' || accounting_json_text(e."documentRef")
    || ',"entryDate":"' || to_char(e."entryDate", 'YYYY-MM-DD') || '"'
    || ',"fiscalYearId":' || accounting_json_text(e."fiscalYearId")
    || ',"journalId":' || accounting_json_text(e."journalId")
    || ',"label":' || accounting_json_text(e."label")
    || ',"lines":' || coalesce((
         SELECT '[' || string_agg(
             '{"accountId":' || accounting_json_text(l."accountId")
           || ',"creditCents":"' || l."creditCents"::text || '"'
           || ',"debitCents":"' || l."debitCents"::text || '"'
           || ',"label":' || accounting_json_text(l."label")
           || ',"position":' || l."position"::text
           || ',"vatRateBp":' || coalesce(l."vatRateBp"::text, 'null')
           || '}', ',' ORDER BY l."position") || ']'
         FROM "journal_entry_lines" l WHERE l."entryId" = e."id"), '[]')
    || ',"number":' || coalesce(e."number"::text, 'null')
    || ',"prevHash":' || accounting_json_text(e."prevHash")
    || ',"reversalOfId":' || accounting_json_text(e."reversalOfId")
    || ',"sourceId":' || accounting_json_text(e."sourceId")
    || ',"sourceType":' || accounting_json_text(e."sourceType")
    || ',"sourceVersion":' || coalesce(e."sourceVersion"::text, 'null')
    || ',"validatedAt":' || CASE WHEN e."validatedAt" IS NULL THEN 'null' ELSE '"' || to_char(e."validatedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '"' END
    || ',"validatedById":' || accounting_json_text(e."validatedById")
    || ',"version":1'
    || '}'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION accounting_entry_hash(e "journal_entries") RETURNS text AS $$
  SELECT encode(sha256(convert_to(accounting_entry_canonical(e), 'UTF8')), 'hex')
$$ LANGUAGE sql STABLE;

-- Exercices : pas de chevauchement par société, états vers l'avant, dates figées dès qu'une écriture existe.
CREATE OR REPLACE FUNCTION fiscal_years_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FISCAL_YEAR_IMMUTABLE: un exercice ne se supprime pas.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('fiscal_years:' || NEW."companyId"));
  IF TG_OP = 'UPDATE' THEN
    IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'FISCAL_YEAR_IMMUTABLE: société ou identifiant non modifiables.';
    END IF;
    IF NOT ((OLD."status" = NEW."status") OR (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSING') OR (OLD."status" = 'CLOSING' AND NEW."status" = 'CLOSED')) THEN
      RAISE EXCEPTION 'FISCAL_YEAR_IMMUTABLE: transition % -> % interdite.', OLD."status", NEW."status";
    END IF;
    IF NEW."status" <> OLD."status" AND NOT accounting_engine_context() THEN
      RAISE EXCEPTION 'FISCAL_YEAR_TRANSITION_DENIED: changement d''état réservé au service comptable.';
    END IF;
    IF (NEW."startDate" IS DISTINCT FROM OLD."startDate" OR NEW."endDate" IS DISTINCT FROM OLD."endDate")
       AND (OLD."status" <> 'OPEN' OR EXISTS (SELECT 1 FROM "journal_entries" e WHERE e."fiscalYearId" = OLD."id")) THEN
      RAISE EXCEPTION 'FISCAL_YEAR_IMMUTABLE: dates figées (exercice utilisé ou non ouvert).';
    END IF;
  ELSIF NEW."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'FISCAL_YEAR_IMMUTABLE: un exercice est créé ouvert.';
  END IF;
  IF EXISTS (SELECT 1 FROM "fiscal_years" f WHERE f."companyId" = NEW."companyId" AND f."id" <> NEW."id"
             AND f."startDate" <= NEW."endDate" AND NEW."startDate" <= f."endDate") THEN
    RAISE EXCEPTION 'FISCAL_YEAR_OVERLAP: exercices chevauchants.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER fiscal_years_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "fiscal_years"
  FOR EACH ROW EXECUTE FUNCTION fiscal_years_guard();

-- Comptes : numéro et société figés ; pas de suppression d'un compte utilisé.
CREATE OR REPLACE FUNCTION accounting_accounts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "journal_entry_lines" l WHERE l."accountId" = OLD."id") THEN
      RAISE EXCEPTION 'ACCOUNT_IN_USE: compte % utilisé.', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."number" IS DISTINCT FROM OLD."number" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'ACCOUNT_IMMUTABLE: numéro ou société non modifiables (%).', OLD."number";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounting_accounts_guard_trg BEFORE UPDATE OR DELETE ON "accounting_accounts"
  FOR EACH ROW EXECUTE FUNCTION accounting_accounts_guard();

-- Écritures : création en brouillon ; validation uniquement par le service ; validées immuables.
CREATE OR REPLACE FUNCTION journal_entries_guard() RETURNS trigger AS $$
DECLARE
  v_last int; h record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'ENTRY_IMMUTABLE: une écriture est créée en brouillon.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'VALIDATED' THEN
      RAISE EXCEPTION 'ENTRY_IMMUTABLE: écriture validée % non supprimable.', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'VALIDATED' THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: écriture validée % non modifiable.', OLD."number";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: identifiant ou société non modifiables.';
  END IF;
  IF NEW."status" = 'VALIDATED' THEN
    IF NOT accounting_engine_context() THEN
      RAISE EXCEPTION 'ENTRY_POSTING_DENIED: validation réservée au service comptable.';
    END IF;
    -- Cohérence indépendante du chemin : numéro = compteur courant, chaînage = tête courante, empreinte recalculée.
    SELECT "lastNumber" INTO v_last FROM "accounting_sequences"
      WHERE "companyId" = NEW."companyId" AND "journalId" = NEW."journalId" AND "fiscalYearId" = NEW."fiscalYearId";
    IF v_last IS NULL OR NEW."number" IS DISTINCT FROM v_last THEN
      RAISE EXCEPTION 'ENTRY_INTEGRITY: numéro % non attribué par le compteur.', NEW."number";
    END IF;
    SELECT "lastEntryId", "lastHash" INTO h FROM "accounting_chain_heads" WHERE "companyId" = NEW."companyId" AND "journalId" = NEW."journalId";
    IF NOT FOUND OR NEW."prevHash" IS DISTINCT FROM h."lastHash" OR NEW."prevEntryId" IS DISTINCT FROM h."lastEntryId" THEN
      RAISE EXCEPTION 'ENTRY_INTEGRITY: chaînage de l''écriture % incohérent avec la tête du journal.', NEW."number";
    END IF;
    IF NEW."hash" IS DISTINCT FROM accounting_entry_hash(NEW) THEN
      RAISE EXCEPTION 'ENTRY_INTEGRITY: empreinte de l''écriture % incorrecte.', NEW."number";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entries_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

-- Lignes : verrou partagé de(s) écriture(s) parente(s), refus si validée (toute mutation, y compris déplacement).
CREATE OR REPLACE FUNCTION journal_entry_lines_guard() RETURNS trigger AS $$
DECLARE
  p_ids text[];
BEGIN
  IF TG_OP = 'INSERT' THEN p_ids := ARRAY[NEW."entryId"];
  ELSIF TG_OP = 'DELETE' THEN p_ids := ARRAY[OLD."entryId"];
  ELSE p_ids := ARRAY[OLD."entryId", NEW."entryId"];
  END IF;
  PERFORM 1 FROM "journal_entries" WHERE "id" = ANY(p_ids) ORDER BY "id" FOR SHARE;
  IF EXISTS (SELECT 1 FROM "journal_entries" WHERE "id" = ANY(p_ids) AND "status" = 'VALIDATED') THEN
    RAISE EXCEPTION 'ENTRY_IMMUTABLE: lignes d''une écriture validée non modifiables.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER journal_entry_lines_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "journal_entry_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_entry_lines_guard();

-- Séquences et têtes de chaîne : modifiables uniquement par le service, numérotation +1.
CREATE OR REPLACE FUNCTION accounting_sequences_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SEQUENCE_IMMUTABLE: suppression interdite.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."lastNumber" <> 0 THEN RAISE EXCEPTION 'SEQUENCE_IMMUTABLE: une séquence démarre à 0.'; END IF;
    RETURN NEW;
  END IF;
  IF NOT accounting_engine_context() OR NEW."lastNumber" <> OLD."lastNumber" + 1
     OR NEW."companyId" <> OLD."companyId" OR NEW."journalId" <> OLD."journalId" OR NEW."fiscalYearId" <> OLD."fiscalYearId" THEN
    RAISE EXCEPTION 'SEQUENCE_IMMUTABLE: incrément de 1 uniquement, par le service comptable.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounting_sequences_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "accounting_sequences"
  FOR EACH ROW EXECUTE FUNCTION accounting_sequences_guard();

CREATE OR REPLACE FUNCTION accounting_chain_heads_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CHAIN_IMMUTABLE: suppression interdite.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."lastEntryId" IS NOT NULL OR NEW."lastHash" <> encode(sha256(convert_to('GENESIS|' || NEW."companyId" || '|' || NEW."journalId", 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'CHAIN_IMMUTABLE: une chaîne démarre à son empreinte d''origine.';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT accounting_engine_context() OR NEW."companyId" <> OLD."companyId" OR NEW."journalId" <> OLD."journalId" THEN
    RAISE EXCEPTION 'CHAIN_IMMUTABLE: tête de chaîne modifiable uniquement par le service comptable.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "journal_entries" x WHERE x."id" = NEW."lastEntryId" AND x."companyId" = NEW."companyId"
                 AND x."journalId" = NEW."journalId" AND x."status" = 'VALIDATED'
                 AND x."prevEntryId" IS NOT DISTINCT FROM OLD."lastEntryId" AND x."prevHash" = OLD."lastHash" AND x."hash" = NEW."lastHash") THEN
    RAISE EXCEPTION 'CHAIN_INTEGRITY: la tête doit avancer vers l''écriture validée qui succède à l''ancienne tête.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER accounting_chain_heads_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "accounting_chain_heads"
  FOR EACH ROW EXECUTE FUNCTION accounting_chain_heads_guard();

-- Contrôle différé (COMMIT) d'une écriture validée : équilibre, ≥ 2 lignes, comptes actifs, exercice
-- ouvert contenant la date (CLOSING : seulement OD de clôture), contre-passation miroir.
CREATE OR REPLACE FUNCTION journal_entries_validation_check() RETURNS trigger AS $$
DECLARE
  e record; fy record; j record;
  n int; d numeric; c numeric; inactive int;
BEGIN
  SELECT * INTO e FROM "journal_entries" WHERE "id" = NEW."id";
  IF NOT FOUND OR e."status" <> 'VALIDATED' THEN RETURN NULL; END IF;
  SELECT count(*), coalesce(sum("debitCents"),0), coalesce(sum("creditCents"),0) INTO n, d, c
    FROM "journal_entry_lines" WHERE "entryId" = e."id";
  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'ENTRY_UNBALANCED: écriture % déséquilibrée ou incomplète (% lignes, D=% C=%).', e."number", n, d, c;
  END IF;
  SELECT count(*) INTO inactive FROM "journal_entry_lines" l JOIN "accounting_accounts" a ON a."id" = l."accountId"
    WHERE l."entryId" = e."id" AND (NOT a."active" OR a."companyId" <> e."companyId");
  IF inactive > 0 THEN RAISE EXCEPTION 'ENTRY_ACCOUNT_INACTIVE: compte inactif dans l''écriture %.', e."number"; END IF;
  SELECT * INTO fy FROM "fiscal_years" WHERE "id" = e."fiscalYearId";
  IF e."entryDate" < fy."startDate" OR e."entryDate" > fy."endDate" THEN
    RAISE EXCEPTION 'ENTRY_DATE_OUTSIDE_YEAR: date hors exercice (%).', e."number";
  END IF;
  SELECT * INTO j FROM "accounting_journals" WHERE "id" = e."journalId";
  IF NOT (fy."status" = 'OPEN' OR (fy."status" = 'CLOSING' AND e."closingEntry" AND j."kind" = 'MISC')) THEN
    RAISE EXCEPTION 'ENTRY_YEAR_NOT_OPEN: exercice % fermé à la validation.', fy."status";
  END IF;
  IF e."reversalOfId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "journal_entries" o WHERE o."id" = e."reversalOfId" AND o."status" = 'VALIDATED' AND o."companyId" = e."companyId")
       OR EXISTS (
         (SELECT "accountId", "debitCents", "creditCents" FROM "journal_entry_lines" WHERE "entryId" = e."id"
          EXCEPT ALL SELECT "accountId", "creditCents", "debitCents" FROM "journal_entry_lines" WHERE "entryId" = e."reversalOfId")
         UNION ALL
         (SELECT "accountId", "creditCents", "debitCents" FROM "journal_entry_lines" WHERE "entryId" = e."reversalOfId"
          EXCEPT ALL SELECT "accountId", "debitCents", "creditCents" FROM "journal_entry_lines" WHERE "entryId" = e."id")) THEN
      RAISE EXCEPTION 'ENTRY_REVERSAL_INVALID: la contre-passation % n''est pas le miroir exact de l''écriture d''origine.', e."number";
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "accounting_chain_heads" h WHERE h."companyId" = e."companyId" AND h."journalId" = e."journalId" AND h."lastEntryId" = e."id")
     AND NOT EXISTS (SELECT 1 FROM "journal_entries" n WHERE n."companyId" = e."companyId" AND n."journalId" = e."journalId"
                     AND n."prevEntryId" = e."id" AND n."status" = 'VALIDATED') THEN
    RAISE EXCEPTION 'CHAIN_INTEGRITY: écriture % hors chaîne (ni tête, ni prédécesseur).', e."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER journal_entries_validation_check_trg
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entries_validation_check();


-- Contrôle différé des compteurs : dernier numéro = nombre = maximum des écritures validées du périmètre (sans trou).
CREATE OR REPLACE FUNCTION accounting_sequences_check() RETURNS trigger AS $$
DECLARE
  v_last int; n int; mx int;
BEGIN
  SELECT "lastNumber" INTO v_last FROM "accounting_sequences"
    WHERE "companyId" = NEW."companyId" AND "journalId" = NEW."journalId" AND "fiscalYearId" = NEW."fiscalYearId";
  SELECT count(*), coalesce(max("number"), 0) INTO n, mx FROM "journal_entries"
    WHERE "companyId" = NEW."companyId" AND "journalId" = NEW."journalId" AND "fiscalYearId" = NEW."fiscalYearId" AND "status" = 'VALIDATED';
  IF v_last <> mx OR n <> mx THEN
    RAISE EXCEPTION 'SEQUENCE_INTEGRITY: compteur % incohérent avec les écritures validées (% écritures, max %).', v_last, n, mx;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER accounting_sequences_check_trg
  AFTER INSERT OR UPDATE ON "accounting_sequences"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_sequences_check();

-- Contrôle différé des têtes : la tête pointe la dernière écriture de la chaîne (aucun successeur validé).
CREATE OR REPLACE FUNCTION accounting_chain_heads_check() RETURNS trigger AS $$
DECLARE
  h record;
BEGIN
  SELECT * INTO h FROM "accounting_chain_heads" WHERE "companyId" = NEW."companyId" AND "journalId" = NEW."journalId";
  IF EXISTS (SELECT 1 FROM "journal_entries" n WHERE n."companyId" = h."companyId" AND n."journalId" = h."journalId" AND n."status" = 'VALIDATED'
             AND n."prevEntryId" IS NOT DISTINCT FROM h."lastEntryId" AND (h."lastEntryId" IS NOT NULL OR n."prevHash" = h."lastHash")) THEN
    RAISE EXCEPTION 'CHAIN_INTEGRITY: la tête du journal n''est pas la dernière écriture de la chaîne.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER accounting_chain_heads_check_trg
  AFTER INSERT OR UPDATE ON "accounting_chain_heads"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION accounting_chain_heads_check();

-- ═══════════════════════════════════════════════════════════════════════════
-- Seuls points d'entrée des mutations protégées (SECURITY DEFINER, search_path figé).
-- Ils garantissent l'intégrité du registre (numéro, chaîne, empreinte, audit), quel que soit l'appelant ;
-- l'autorisation de l'utilisateur final (ADMIN de la société, non révoqué) reste vérifiée par le service
-- applicatif, qui verrouille les lignes d'autorité avant l'appel.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION accounting_post_entry(p_company_id text, p_entry_id text, p_user_id text)
RETURNS TABLE(entry_id text, entry_number integer, entry_hash text) AS $$
DECLARE
  e "journal_entries"; v_fy text; v_num int; h record; v_at timestamp(3);
BEGIN
  SELECT "fiscalYearId" INTO v_fy FROM "journal_entries" WHERE "id" = p_entry_id AND "companyId" = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENTRY_NOT_FOUND: écriture introuvable pour cette société.'; END IF;
  -- Ordre unique des verrous : exercice → écriture → compteur → tête.
  PERFORM 1 FROM "fiscal_years" WHERE "id" = v_fy AND "companyId" = p_company_id FOR NO KEY UPDATE;
  SELECT * INTO e FROM "journal_entries" WHERE "id" = p_entry_id AND "companyId" = p_company_id FOR NO KEY UPDATE;
  IF e."status" = 'VALIDATED' THEN
    RETURN QUERY SELECT e."id", e."number", e."hash";
    RETURN;
  END IF;
  PERFORM set_config('planificator.accounting_engine', 'on', true);

  INSERT INTO "accounting_sequences" ("companyId", "journalId", "fiscalYearId", "lastNumber")
    VALUES (p_company_id, e."journalId", e."fiscalYearId", 0) ON CONFLICT DO NOTHING;
  SELECT "lastNumber" INTO v_num FROM "accounting_sequences"
    WHERE "companyId" = p_company_id AND "journalId" = e."journalId" AND "fiscalYearId" = e."fiscalYearId" FOR NO KEY UPDATE;
  v_num := v_num + 1;
  UPDATE "accounting_sequences" SET "lastNumber" = v_num
    WHERE "companyId" = p_company_id AND "journalId" = e."journalId" AND "fiscalYearId" = e."fiscalYearId";

  INSERT INTO "accounting_chain_heads" ("companyId", "journalId", "lastEntryId", "lastHash")
    VALUES (p_company_id, e."journalId", NULL, encode(sha256(convert_to('GENESIS|' || p_company_id || '|' || e."journalId", 'UTF8')), 'hex'))
    ON CONFLICT DO NOTHING;
  SELECT "lastEntryId", "lastHash" INTO h FROM "accounting_chain_heads"
    WHERE "companyId" = p_company_id AND "journalId" = e."journalId" FOR NO KEY UPDATE;

  v_at := date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC');
  e."status" := 'VALIDATED';
  e."number" := v_num;
  e."validatedAt" := v_at;
  e."validatedById" := p_user_id;
  e."prevEntryId" := h."lastEntryId";
  e."prevHash" := h."lastHash";
  e."hash" := accounting_entry_hash(e);

  UPDATE "journal_entries" SET "status" = e."status", "number" = e."number", "validatedAt" = e."validatedAt",
      "validatedById" = e."validatedById", "prevEntryId" = e."prevEntryId", "prevHash" = e."prevHash", "hash" = e."hash",
      "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
    WHERE "id" = e."id" AND "status" = 'DRAFT';
  UPDATE "accounting_chain_heads" SET "lastEntryId" = e."id", "lastHash" = e."hash"
    WHERE "companyId" = p_company_id AND "journalId" = e."journalId";

  INSERT INTO "history_logs" ("id", "companyId", "actorId", "action", "entityType", "entityId", "detail", "newValue", "createdAt")
  VALUES ('acc_' || replace(gen_random_uuid()::text, '-', ''), p_company_id, p_user_id, 'STATUS_CHANGED', 'JournalEntry', e."id",
          'Écriture n° ' || v_num || ' validée'
            || CASE WHEN e."reversalOfId" IS NOT NULL THEN ' (contre-passation)' ELSE '' END
            || CASE WHEN e."closingEntry" THEN ' (OD de clôture)' ELSE '' END,
          jsonb_build_object('status', 'VALIDATED', 'journalId', e."journalId", 'fiscalYearId', e."fiscalYearId", 'number', v_num,
                             'hash', e."hash", 'reversalOfId', e."reversalOfId", 'closingEntry', e."closingEntry"),
          clock_timestamp() AT TIME ZONE 'UTC');

  -- Contrôles différés exécutés maintenant (Prisma n'expose pas de façon fiable une erreur levée au COMMIT).
  SET CONSTRAINTS journal_entries_validation_check_trg, accounting_sequences_check_trg, accounting_chain_heads_check_trg IMMEDIATE;
  SET CONSTRAINTS journal_entries_validation_check_trg, accounting_sequences_check_trg, accounting_chain_heads_check_trg DEFERRED;
  PERFORM set_config('planificator.accounting_engine', 'off', true);
  RETURN QUERY SELECT e."id", e."number", e."hash";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION accounting_advance_fiscal_year(p_company_id text, p_fiscal_year_id text, p_to text, p_user_id text)
RETURNS void AS $$
DECLARE
  v_from text;
BEGIN
  SELECT "status"::text INTO v_from FROM "fiscal_years" WHERE "id" = p_fiscal_year_id AND "companyId" = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FISCAL_YEAR_NOT_FOUND: exercice introuvable pour cette société.'; END IF;
  IF NOT ((v_from = 'OPEN' AND p_to = 'CLOSING') OR (v_from = 'CLOSING' AND p_to = 'CLOSED')) THEN
    RAISE EXCEPTION 'FISCAL_YEAR_TRANSITION_INVALID: % -> % interdite.', v_from, p_to;
  END IF;
  PERFORM set_config('planificator.accounting_engine', 'on', true);
  UPDATE "fiscal_years" SET "status" = p_to::"FiscalYearStatus" WHERE "id" = p_fiscal_year_id AND "companyId" = p_company_id;
  INSERT INTO "history_logs" ("id", "companyId", "actorId", "action", "entityType", "entityId", "detail", "oldValue", "newValue", "createdAt")
  VALUES ('acc_' || replace(gen_random_uuid()::text, '-', ''), p_company_id, p_user_id, 'STATUS_CHANGED', 'FiscalYear', p_fiscal_year_id,
          'Exercice : ' || v_from || ' → ' || p_to, jsonb_build_object('status', v_from), jsonb_build_object('status', p_to),
          clock_timestamp() AT TIME ZONE 'UTC');
  PERFORM set_config('planificator.accounting_engine', 'off', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- search_path figé au schéma de la migration (pg_temp en dernier : pas de détournement par table temporaire).
DO $$
BEGIN
  EXECUTE format('ALTER FUNCTION accounting_post_entry(text, text, text) SET search_path = %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION accounting_advance_fiscal_year(text, text, text, text) SET search_path = %I, pg_temp', current_schema());
END $$;

-- Points d'entrée non exposés par défaut : seul le propriétaire peut les exécuter. Le rôle applicatif
-- (non propriétaire) reçoit EXECUTE au déploiement : GRANT EXECUTE ON FUNCTION … TO <rôle applicatif>.
REVOKE EXECUTE ON FUNCTION accounting_post_entry(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION accounting_advance_fiscal_year(text, text, text, text) FROM PUBLIC;
