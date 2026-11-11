-- Lot A Planificator V2 (04/11/2026) : stocks multi-dépôts, commandes d'achat et réceptions.
-- Migration EXPAND, purement additive : 2 types, 7 tables, leurs index et clés, et 1 index unique sur "articles"
-- ("companyId", "id"), nécessaire aux clés composites d'entreprise. Aucune ligne existante lue ni écrite.
-- Corps généré par `prisma migrate diff` (schéma 379a016 vers ce lot), puis contraintes CHECK de défense en
-- profondeur ajoutées à la main (fin de fichier). Module désactivé par défaut (STOCK_PURCHASING_ENABLED).

BEGIN;

CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'ISSUE', 'TRANSFER', 'ADJUSTMENT');

CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_levels" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "quantityMilli" INTEGER NOT NULL DEFAULT 0,
    "minQuantityMilli" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "articleId" TEXT NOT NULL,
    "fromWarehouseId" TEXT,
    "toWarehouseId" TEXT,
    "quantityMilli" INTEGER NOT NULL,
    "worksiteId" TEXT,
    "goodsReceiptLineId" TEXT,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderedAt" TIMESTAMP(3),
    "expectedAt" DATE,
    "notes" TEXT,
    "totalHTCents" BIGINT NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "articleId" TEXT,
    "designation" TEXT NOT NULL,
    "quantityMilli" INTEGER NOT NULL,
    "receivedMilli" INTEGER NOT NULL DEFAULT 0,
    "unitPriceCents" INTEGER NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "supplierInvoiceId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "goodsReceiptId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "quantityMilli" INTEGER NOT NULL,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouses_companyId_id_key" ON "warehouses"("companyId", "id");

CREATE UNIQUE INDEX "warehouses_companyId_name_key" ON "warehouses"("companyId", "name");

CREATE INDEX "stock_levels_companyId_articleId_idx" ON "stock_levels"("companyId", "articleId");

CREATE UNIQUE INDEX "stock_levels_warehouseId_articleId_key" ON "stock_levels"("warehouseId", "articleId");

CREATE UNIQUE INDEX "stock_movements_goodsReceiptLineId_key" ON "stock_movements"("goodsReceiptLineId");

CREATE INDEX "stock_movements_companyId_createdAt_idx" ON "stock_movements"("companyId", "createdAt");

CREATE INDEX "stock_movements_companyId_articleId_idx" ON "stock_movements"("companyId", "articleId");

CREATE INDEX "stock_movements_companyId_worksiteId_idx" ON "stock_movements"("companyId", "worksiteId");

CREATE INDEX "purchase_orders_companyId_status_idx" ON "purchase_orders"("companyId", "status");

CREATE UNIQUE INDEX "purchase_orders_companyId_id_key" ON "purchase_orders"("companyId", "id");

CREATE UNIQUE INDEX "purchase_orders_companyId_number_key" ON "purchase_orders"("companyId", "number");

CREATE UNIQUE INDEX "purchase_order_lines_purchaseOrderId_position_key" ON "purchase_order_lines"("purchaseOrderId", "position");

CREATE INDEX "goods_receipts_companyId_purchaseOrderId_idx" ON "goods_receipts"("companyId", "purchaseOrderId");

CREATE UNIQUE INDEX "goods_receipts_companyId_number_key" ON "goods_receipts"("companyId", "number");

CREATE UNIQUE INDEX "goods_receipt_lines_goodsReceiptId_orderLineId_key" ON "goods_receipt_lines"("goodsReceiptId", "orderLineId");

CREATE UNIQUE INDEX "articles_companyId_id_key" ON "articles"("companyId", "id");

ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_companyId_warehouseId_fkey" FOREIGN KEY ("companyId", "warehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_companyId_articleId_fkey" FOREIGN KEY ("companyId", "articleId") REFERENCES "articles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_articleId_fkey" FOREIGN KEY ("companyId", "articleId") REFERENCES "articles"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_fromWarehouseId_fkey" FOREIGN KEY ("companyId", "fromWarehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_companyId_toWarehouseId_fkey" FOREIGN KEY ("companyId", "toWarehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_goodsReceiptLineId_fkey" FOREIGN KEY ("goodsReceiptLineId") REFERENCES "goods_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_warehouseId_fkey" FOREIGN KEY ("companyId", "warehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_companyId_purchaseOrderId_fkey" FOREIGN KEY ("companyId", "purchaseOrderId") REFERENCES "purchase_orders"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_companyId_warehouseId_fkey" FOREIGN KEY ("companyId", "warehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_companyId_supplierInvoiceId_fkey" FOREIGN KEY ("companyId", "supplierInvoiceId") REFERENCES "supplier_invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goodsReceiptId_fkey" FOREIGN KEY ("goodsReceiptId") REFERENCES "goods_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "purchase_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Défense en profondeur (le service applique les mêmes règles avant d'écrire).
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_values_check" CHECK (
  length(btrim("name")) BETWEEN 1 AND 120 AND "name" = btrim("name")
  AND ("address" IS NULL OR length("address") <= 500)
);
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_values_check" CHECK (
  "quantityMilli" >= 0 AND ("minQuantityMilli" IS NULL OR "minQuantityMilli" >= 0)
);
-- Sens des mouvements : entrée vers un dépôt, sortie depuis un dépôt, transfert entre deux dépôts distincts,
-- ajustement d'un seul côté avec motif obligatoire. Quantité toujours strictement positive.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_values_check" CHECK (
  "quantityMilli" > 0
  AND length(btrim("createdById")) > 0
  AND (
    ("type" = 'RECEIPT' AND "toWarehouseId" IS NOT NULL AND "fromWarehouseId" IS NULL)
    OR ("type" = 'ISSUE' AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NULL)
    OR ("type" = 'TRANSFER' AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NOT NULL AND "fromWarehouseId" <> "toWarehouseId")
    OR ("type" = 'ADJUSTMENT' AND (("fromWarehouseId" IS NULL) <> ("toWarehouseId" IS NULL))
        AND "reason" IS NOT NULL AND length(btrim("reason")) BETWEEN 1 AND 500)
  )
  AND ("goodsReceiptLineId" IS NULL OR "type" = 'RECEIPT')
);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_values_check" CHECK (
  "totalHTCents" >= 0 AND length(btrim("number")) > 0 AND length(btrim("createdById")) > 0
  AND ("status" = 'DRAFT' OR "status" = 'CANCELLED' OR "orderedAt" IS NOT NULL)
);
-- Pas de surréception : la quantité reçue reste entre 0 et la quantité commandée.
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_values_check" CHECK (
  "quantityMilli" > 0 AND "receivedMilli" >= 0 AND "receivedMilli" <= "quantityMilli"
  AND "unitPriceCents" >= 0 AND "position" >= 0
  AND length(btrim("designation")) BETWEEN 1 AND 500
);
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_values_check" CHECK ("quantityMilli" > 0);

COMMIT;
