-- Lot I Planificator V2 (19/11/2026) : marketing et boutique, LABORATOIRE INTERNE sur données fictives. Migration EXPAND,
-- additive : 2 types et 7 tables nouveaux, leurs index, clés et contraintes. Aucun objet existant modifié, aucune ligne
-- existante lue ni écrite (les clés étrangères composites s'appuient sur les clés uniques déjà présentes
-- "articles"("companyId","id") et "clients"("id","companyId")). Corps au format de `prisma migrate diff`, puis CHECK et
-- déclencheurs à la main en fin de fichier. Module désactivé par défaut (MARKETING_SHOP_ENABLED). Aucun paiement,
-- aucune facture, aucun devis, aucun mouvement de stock, aucun prestataire externe.
-- Garanties portées par la base : liaisons limitées à une même société (clés composites) ; commandes, lignes et
-- conversions immuables ; totaux d'une commande égaux à la somme de ses lignes (contrôle différé à la validation) ;
-- au plus une conversion par commande ; conversion seulement avec un consentement ACCORDÉ, relu sous verrou partagé.

BEGIN;

-- CreateEnum
CREATE TYPE "MarketingChannel" AS ENUM ('WEBSITE', 'SOCIAL_MEDIA', 'EMAILING', 'PRINT', 'EVENT', 'REFERRAL', 'PARTNER', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketingConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "marketing_sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" "MarketingChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" DATE,
    "endsOn" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "MarketingConsentStatus" NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "grantedById" TEXT NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_promotions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "percentBp" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,
    "validFrom" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "promotionId" TEXT,
    "promotionCode" TEXT,
    "promotionPercentBp" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "subtotalCents" BIGINT NOT NULL,
    "discountCents" BIGINT NOT NULL,
    "totalHTCents" BIGINT NOT NULL,
    "totalVATCents" BIGINT NOT NULL,
    "totalTTCCents" BIGINT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_order_lines" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "articleId" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" BIGINT NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "grossCents" BIGINT NOT NULL,
    "discountCents" BIGINT NOT NULL,
    "netCents" BIGINT NOT NULL,
    "vatCents" BIGINT NOT NULL,

    CONSTRAINT "shop_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_conversions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "attributedHTCents" BIGINT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "marketing_sources_companyId_id_key" ON "marketing_sources"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_sources_companyId_name_key" ON "marketing_sources"("companyId", "name");

-- CreateIndex
CREATE INDEX "marketing_campaigns_companyId_sourceId_idx" ON "marketing_campaigns"("companyId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_companyId_id_key" ON "marketing_campaigns"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_campaigns_companyId_name_key" ON "marketing_campaigns"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_companyId_id_key" ON "marketing_consents"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_consents_companyId_clientId_key" ON "marketing_consents"("companyId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_promotions_companyId_id_key" ON "shop_promotions"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_promotions_companyId_code_key" ON "shop_promotions"("companyId", "code");

-- CreateIndex
CREATE INDEX "shop_orders_companyId_createdAt_idx" ON "shop_orders"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "shop_orders_clientId_companyId_idx" ON "shop_orders"("clientId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_companyId_id_key" ON "shop_orders"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_companyId_id_clientId_key" ON "shop_orders"("companyId", "id", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_orders_companyId_idempotencyKey_key" ON "shop_orders"("companyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "shop_order_lines_companyId_orderId_idx" ON "shop_order_lines"("companyId", "orderId");

-- CreateIndex
CREATE INDEX "shop_order_lines_companyId_articleId_idx" ON "shop_order_lines"("companyId", "articleId");

-- CreateIndex
CREATE UNIQUE INDEX "shop_order_lines_orderId_position_key" ON "shop_order_lines"("orderId", "position");

-- CreateIndex
CREATE INDEX "marketing_conversions_companyId_campaignId_idx" ON "marketing_conversions"("companyId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_conversions_companyId_id_key" ON "marketing_conversions"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_conversions_companyId_orderId_key" ON "marketing_conversions"("companyId", "orderId");

-- AddForeignKey
ALTER TABLE "marketing_sources" ADD CONSTRAINT "marketing_sources_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_companyId_sourceId_fkey" FOREIGN KEY ("companyId", "sourceId") REFERENCES "marketing_sources"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_promotions" ADD CONSTRAINT "shop_promotions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_companyId_promotionId_fkey" FOREIGN KEY ("companyId", "promotionId") REFERENCES "shop_promotions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_companyId_orderId_fkey" FOREIGN KEY ("companyId", "orderId") REFERENCES "shop_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_companyId_articleId_fkey" FOREIGN KEY ("companyId", "articleId") REFERENCES "articles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_conversions" ADD CONSTRAINT "marketing_conversions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_conversions" ADD CONSTRAINT "marketing_conversions_companyId_orderId_clientId_fkey" FOREIGN KEY ("companyId", "orderId", "clientId") REFERENCES "shop_orders"("companyId", "id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_conversions" ADD CONSTRAINT "marketing_conversions_companyId_campaignId_fkey" FOREIGN KEY ("companyId", "campaignId") REFERENCES "marketing_campaigns"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_conversions" ADD CONSTRAINT "marketing_conversions_companyId_clientId_fkey" FOREIGN KEY ("companyId", "clientId") REFERENCES "marketing_consents"("companyId", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "marketing_sources" ADD CONSTRAINT "marketing_sources_values_check" CHECK (
  length(btrim("name")) BETWEEN 2 AND 120
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_values_check" CHECK (
  length(btrim("name")) BETWEEN 2 AND 120
  AND length(btrim("createdById")) > 0
  AND ("startsOn" IS NULL OR "endsOn" IS NULL OR "endsOn" >= "startsOn")
);

-- Consentement : jamais implicite ; accordé ⇒ aucun retrait renseigné ; retiré ⇒ date et auteur du retrait renseignés.
ALTER TABLE "marketing_consents" ADD CONSTRAINT "marketing_consents_values_check" CHECK (
  length(btrim("grantedById")) > 0
  AND (
    ("status" = 'GRANTED' AND "withdrawnAt" IS NULL AND "withdrawnById" IS NULL)
    OR ("status" = 'WITHDRAWN' AND "withdrawnAt" IS NOT NULL AND "withdrawnById" IS NOT NULL AND length(btrim("withdrawnById")) > 0)
  )
);

ALTER TABLE "shop_promotions" ADD CONSTRAINT "shop_promotions_values_check" CHECK (
  "code" ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'
  AND "percentBp" BETWEEN 1 AND 10000
  AND "validUntil" >= "validFrom"
  AND length(btrim("createdById")) > 0
);

-- Commande : clé idempotente bornée, empreinte de la requête, promotion figée cohérente, totaux cohérents.
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_values_check" CHECK (
  "idempotencyKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND "requestSha256" ~ '^[0-9a-f]{64}$'
  AND length(btrim("createdById")) > 0
  AND (
    ("promotionId" IS NULL AND "promotionCode" IS NULL AND "promotionPercentBp" = 0)
    OR ("promotionId" IS NOT NULL AND "promotionCode" IS NOT NULL AND "promotionPercentBp" BETWEEN 1 AND 10000)
  )
  AND "lineCount" BETWEEN 1 AND 20
  AND "subtotalCents" >= 0
  AND "discountCents" BETWEEN 0 AND "subtotalCents"
  AND "totalHTCents" = "subtotalCents" - "discountCents"
  AND "totalVATCents" >= 0
  AND "totalTTCCents" = "totalHTCents" + "totalVATCents"
  AND "totalTTCCents" <= 9999999999
);

-- Ligne : quantité entière bornée, prix et taux figés, montant brut exact, remise bornée, net = brut − remise.
ALTER TABLE "shop_order_lines" ADD CONSTRAINT "shop_order_lines_values_check" CHECK (
  "position" BETWEEN 1 AND 20
  AND "quantity" BETWEEN 1 AND 999
  AND "unitPriceCents" >= 0
  AND "vatRateBp" BETWEEN 0 AND 10000
  AND length(btrim("designation")) > 0
  AND "grossCents" = "quantity"::bigint * "unitPriceCents"
  AND "discountCents" BETWEEN 0 AND "grossCents"
  AND "netCents" = "grossCents" - "discountCents"
  AND "vatCents" >= 0
);

ALTER TABLE "marketing_conversions" ADD CONSTRAINT "marketing_conversions_values_check" CHECK (
  "attributedHTCents" >= 0
  AND length(btrim("createdById")) > 0
);

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION lot_i_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lot I history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER marketing_sources_no_truncate BEFORE TRUNCATE ON "marketing_sources"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER marketing_campaigns_no_truncate BEFORE TRUNCATE ON "marketing_campaigns"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER marketing_consents_no_truncate BEFORE TRUNCATE ON "marketing_consents"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER shop_promotions_no_truncate BEFORE TRUNCATE ON "shop_promotions"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER shop_orders_no_truncate BEFORE TRUNCATE ON "shop_orders"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER shop_order_lines_no_truncate BEFORE TRUNCATE ON "shop_order_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();
CREATE TRIGGER marketing_conversions_no_truncate BEFORE TRUNCATE ON "marketing_conversions"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_i_no_truncate();

-- Sources, campagnes, commandes, lignes et conversions : jamais modifiées ni supprimées.
CREATE FUNCTION lot_i_append_only() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
CREATE TRIGGER marketing_sources_append_only BEFORE UPDATE OR DELETE ON "marketing_sources"
  FOR EACH ROW EXECUTE FUNCTION lot_i_append_only();
CREATE TRIGGER marketing_campaigns_append_only BEFORE UPDATE OR DELETE ON "marketing_campaigns"
  FOR EACH ROW EXECUTE FUNCTION lot_i_append_only();
CREATE TRIGGER shop_orders_append_only BEFORE UPDATE OR DELETE ON "shop_orders"
  FOR EACH ROW EXECUTE FUNCTION lot_i_append_only();
CREATE TRIGGER shop_order_lines_append_only BEFORE UPDATE OR DELETE ON "shop_order_lines"
  FOR EACH ROW EXECUTE FUNCTION lot_i_append_only();
CREATE TRIGGER marketing_conversions_append_only BEFORE UPDATE OR DELETE ON "marketing_conversions"
  FOR EACH ROW EXECUTE FUNCTION lot_i_append_only();

-- Consentement : jamais supprimé (le retrait est un état tracé) ; identité figée.
CREATE FUNCTION marketing_consent_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'marketing consent cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."clientId", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."clientId", OLD."createdAt") THEN
    RAISE EXCEPTION 'marketing consent identity immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_consents_guard BEFORE UPDATE OR DELETE ON "marketing_consents"
  FOR EACH ROW EXECUTE FUNCTION marketing_consent_guard();

-- Promotion : jamais supprimée ; seul l'état actif peut changer (code, pourcentage et fenêtre figés).
CREATE FUNCTION shop_promotion_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shop promotion cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."code", NEW."percentBp", NEW."validFrom", NEW."validUntil", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."code", OLD."percentBp", OLD."validFrom", OLD."validUntil", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'shop promotion terms immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_promotions_guard BEFORE UPDATE OR DELETE ON "shop_promotions"
  FOR EACH ROW EXECUTE FUNCTION shop_promotion_guard();

-- Panier figé, vérifié À LA VALIDATION de la transaction : nombre de lignes EXACTEMENT égal à celui enregistré par le
-- service ("lineCount", 1 à 20) et totaux égaux aux sommes des lignes. Une ligne ajoutée plus tard à une commande
-- existante est refusée, même gratuite (elle ne change aucune somme mais change le nombre de lignes).
CREATE FUNCTION shop_order_totals_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  o_id TEXT;
  o_company TEXT;
  o RECORD;
  s RECORD;
BEGIN
  IF TG_TABLE_NAME = 'shop_orders' THEN o_id := NEW."id"; o_company := NEW."companyId";
  ELSE o_id := NEW."orderId"; o_company := NEW."companyId"; END IF;
  SELECT "lineCount", "subtotalCents", "discountCents", "totalHTCents", "totalVATCents" INTO o FROM "shop_orders" WHERE "id" = o_id AND "companyId" = o_company;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shop order not found' USING ERRCODE = '23503';
  END IF;
  SELECT count(*) AS n, coalesce(sum("grossCents"), 0) AS gross, coalesce(sum("discountCents"), 0) AS discount,
         coalesce(sum("netCents"), 0) AS net, coalesce(sum("vatCents"), 0) AS vat
    INTO s FROM "shop_order_lines" WHERE "orderId" = o_id AND "companyId" = o_company;
  IF s.n <> o."lineCount" THEN
    RAISE EXCEPTION 'shop order line count mismatch' USING ERRCODE = '23514';
  END IF;
  IF s.gross <> o."subtotalCents" OR s.discount <> o."discountCents" OR s.net <> o."totalHTCents" OR s.vat <> o."totalVATCents" THEN
    RAISE EXCEPTION 'shop order totals mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shop_orders_totals_guard AFTER INSERT ON "shop_orders"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shop_order_totals_guard();
CREATE CONSTRAINT TRIGGER shop_order_lines_totals_guard AFTER INSERT ON "shop_order_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shop_order_totals_guard();

-- Conversion : consentement ACCORDÉ relu sous verrou partagé (un retrait concurrent attend, ou est attendu puis relu) ;
-- montant attribué égal au total HT net figé de la commande.
CREATE FUNCTION marketing_conversion_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  c_status TEXT;
  o_total BIGINT;
BEGIN
  SELECT c."status"::text INTO c_status FROM "marketing_consents" c WHERE c."companyId" = NEW."companyId" AND c."clientId" = NEW."clientId" FOR SHARE;
  IF NOT FOUND OR c_status <> 'GRANTED' THEN
    RAISE EXCEPTION 'marketing consent not granted' USING ERRCODE = '23514';
  END IF;
  SELECT o."totalHTCents" INTO o_total FROM "shop_orders" o WHERE o."companyId" = NEW."companyId" AND o."id" = NEW."orderId";
  IF NOT FOUND OR o_total <> NEW."attributedHTCents" THEN
    RAISE EXCEPTION 'marketing conversion amount mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER marketing_conversions_guard BEFORE INSERT ON "marketing_conversions"
  FOR EACH ROW EXECUTE FUNCTION marketing_conversion_guard();

COMMIT;
