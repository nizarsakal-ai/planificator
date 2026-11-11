/**
 * Lot A Planificator V2 : contrôles statiques de la migration et du schéma (purement additive, clés composites
 * d'entreprise, contraintes CHECK), et intégration désactivée par défaut.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sql = readFileSync("prisma/migrations/20261110120000_v2_lot_a_stock_purchasing/migration.sql", "utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["warehouses", "stock_levels", "stock_movements", "purchase_orders", "purchase_order_lines", "goods_receipts", "goods_receipt_lines"]
// Garde « purement additive » : seules les actions référentielles des clés étrangères, sous leur forme exacte émise par
// Prisma (ON DELETE|ON UPDATE puis RESTRICT|CASCADE), sont retirées avant la recherche. Tout autre UPDATE, DELETE, TRUNCATE
// ou INSERT, quelle que soit sa casse, reste refusé, commentaires et chaînes compris (même idiome que les lots C à H).
const FK_ACTION = /\bON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)\b/g
const DML = /\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bINSERT\b/i
const withoutFkActions = (text: string) => text.replace(FK_ACTION, " ")
const hasDml = (text: string) => DML.test(withoutFkActions(text))

describe("migration du lot A", () => {
  it("purement additive : aucune suppression, aucune modification de table existante (sauf l'index unique articles)", () => {
    assert.doesNotMatch(sql, /\bDROP\b/i)
    assert.doesNotMatch(withoutFkActions(sql), DML)
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), `ALTER sur une table existante : ${m[1]}`)
    const onArticles = [...sql.matchAll(/ON "articles"/g)].length
    assert.equal(onArticles, 1)
    assert.match(sql, /CREATE UNIQUE INDEX "articles_companyId_id_key" ON "articles"\("companyId", "id"\);/)
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("garde additive : actions de clés étrangères admises, vraies instructions UPDATE/DELETE/TRUNCATE/INSERT refusées (cas témoins)", () => {
    const fk = 'ALTER TABLE "t" ADD CONSTRAINT "t_u_fkey" FOREIGN KEY ("uId") REFERENCES "u"("id") ON DELETE RESTRICT ON UPDATE CASCADE;'
    const admis = [fk, fk.replace("ON DELETE RESTRICT", "ON DELETE CASCADE"), `${fk}\n${fk}`, 'CREATE TABLE "t" ("id" TEXT NOT NULL);']
    for (const s of admis) assert.equal(hasDml(s), false, s)
    const refuses = [
      'UPDATE "articles" SET "name" = \'x\';',
      'update "articles" set "name" = \'x\';',
      'DELETE FROM "articles";',
      'delete   from "articles";',
      'TRUNCATE "articles";',
      'Truncate TABLE "articles";',
      'INSERT INTO "articles" ("id") VALUES (\'x\');',
      'insert\tinto "articles" ("id") VALUES (\'x\');',
      `${fk}\nUPDATE "articles" SET "name" = 'x';`, // mêlée à une clé étrangère, ligne suivante
      `${fk} DELETE FROM "articles";`, // même ligne qu'une clé étrangère
      'ON UPDATE CASCADE UPDATE "articles" SET "name" = \'x\';', // collée après une action de clé étrangère
      'ON DELETE CASCADEDELETE FROM "articles";', // action non délimitée : non retirée
      '-- commentaire\nINSERT INTO "articles" ("id") VALUES (\'x\');',
      '/* ON DELETE RESTRICT */ TRUNCATE "articles";',
      'CREATE RULE "r" AS ON DELETE TO "articles" DO INSTEAD NOTHING;', // ON DELETE sans action référentielle
      "on delete restrict", // casse non émise par Prisma : non exclue, refus prudent
      "ON  DELETE  RESTRICT", // espaces multiples : non exclus, refus prudent
      "ON DELETE SET NULL", // action absente de ce lot : non exclue, refus prudent
      "-- UPDATE cité dans un commentaire", // commentaires non exemptés : refus prudent
      'COMMENT ON TABLE "t" IS \'DELETE\';', // chaînes non exemptées : refus prudent
    ]
    for (const s of refuses) assert.equal(hasDml(s), true, s)
  })
  it("chaque table nouvelle est créée et porte companyId ou appartient à une table qui le porte", () => {
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`CREATE TABLE "${t}"`), t)
    for (const t of ["warehouses", "stock_levels", "stock_movements", "purchase_orders", "goods_receipts"]) {
      const body = sql.split(`CREATE TABLE "${t}" (`)[1].split(");")[0]
      assert.match(body, /"companyId" TEXT NOT NULL/, t)
    }
  })
  it("clés composites d'entreprise vers dépôts, articles, fournisseurs, chantiers, commandes et factures fournisseurs", () => {
    for (const fk of [
      /"stock_levels_companyId_warehouseId_fkey" FOREIGN KEY \("companyId", "warehouseId"\) REFERENCES "warehouses"\("companyId", "id"\)/,
      /"stock_levels_companyId_articleId_fkey" FOREIGN KEY \("companyId", "articleId"\) REFERENCES "articles"\("companyId", "id"\)/,
      /"stock_movements_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\)/,
      /"purchase_orders_companyId_supplierId_fkey" FOREIGN KEY \("companyId", "supplierId"\) REFERENCES "suppliers"\("companyId", "id"\)/,
      /"goods_receipts_companyId_purchaseOrderId_fkey" FOREIGN KEY \("companyId", "purchaseOrderId"\) REFERENCES "purchase_orders"\("companyId", "id"\)/,
      /"goods_receipts_companyId_supplierInvoiceId_fkey" FOREIGN KEY \("companyId", "supplierInvoiceId"\) REFERENCES "supplier_invoices"\("companyId", "id"\)/,
    ]) assert.match(sql, fk)
    for (const stmt of sql.split(";").filter((x) => /REFERENCES\s+"companies"/.test(x))) assert.doesNotMatch(stmt, /ON\s+DELETE\s+CASCADE/, stmt.trim().slice(0, 80))
  })
  it("numéros de commande et de réception uniques par entreprise (index uniques)", () => {
    assert.match(sql, /CREATE UNIQUE INDEX "purchase_orders_companyId_number_key" ON "purchase_orders"\("companyId", "number"\);/)
    assert.match(sql, /CREATE UNIQUE INDEX "goods_receipts_companyId_number_key" ON "goods_receipts"\("companyId", "number"\);/)
    assert.match(sql, /CREATE UNIQUE INDEX "goods_receipt_lines_goodsReceiptId_orderLineId_key"/)
    assert.doesNotMatch(sql, /CREATE TRIGGER|CREATE FUNCTION/i, "aucun déclencheur sur une table existante")
  })
  it("contraintes CHECK : stock jamais négatif, sens des mouvements, pas de surréception", () => {
    assert.match(sql, /"stock_levels_values_check" CHECK \(\s*"quantityMilli" >= 0/)
    assert.match(sql, /"stock_movements_values_check" CHECK \(\s*"quantityMilli" > 0/)
    assert.match(sql, /"type" = 'TRANSFER' AND "fromWarehouseId" IS NOT NULL AND "toWarehouseId" IS NOT NULL AND "fromWarehouseId" <> "toWarehouseId"/)
    assert.match(sql, /"receivedMilli" <= "quantityMilli"/)
    assert.match(sql, /"goods_receipt_lines_values_check" CHECK \("quantityMilli" > 0\)/)
  })
  it("schéma : modèles déclarés, total en BigInt, aucune relation en cascade depuis l'entreprise", () => {
    for (const m of ["Warehouse", "StockLevel", "StockMovement", "PurchaseOrder", "PurchaseOrderLine", "GoodsReceipt", "GoodsReceiptLine"]) assert.match(schema, new RegExp(`^model ${m} \\{`, "m"), m)
    assert.match(schema, /totalHTCents BigInt\s+@default\(0\)/)
    const lotA = schema.split("// Lot A Planificator V2 (04/11/2026)")[1]
    assert.doesNotMatch(lotA.split("\nmodel PurchaseOrderLine")[0], /references: \[id\], onDelete: Cascade/)
  })
})

describe("intégration désactivée par défaut", () => {
  it("menu : entrées ajoutées seulement si visible === true, insérées avant le pied", async () => {
    const { getNavItems, withStockPurchasingNavItems } = await import("@/lib/navigation/nav-config")
    const base = getNavItems("ADMIN")
    assert.deepEqual(withStockPurchasingNavItems(base, false), base)
    const on = withStockPurchasingNavItems(base, true)
    assert.deepEqual(on.filter((i) => !base.includes(i)).map((i) => i.href), ["/stock", "/achats"])
    assert.deepEqual(withStockPurchasingNavItems(on, true).length, on.length, "idempotent")
    assert.equal(on[on.length - 1].href, base[base.length - 1].href)
  })
  it("pages et actions passent par la garde du module", () => {
    for (const f of ["src/app/(dashboard)/stock/page.tsx", "src/app/(dashboard)/stock/mouvements/page.tsx", "src/app/(dashboard)/achats/page.tsx", "src/app/(dashboard)/achats/[id]/page.tsx"]) {
      // v5 (preuves VM B r4, React #310) : refus rendu sur place, PREMIÈRE instruction de la page, avant toute lecture métier.
      const src = readFileSync(f, "utf8")
      const body = src.slice(src.indexOf("export default async function"))
      assert.match(body, /^export default async function \w+\([^\n]*\) \{\n  const ctx = await stockPageAccess\(\)\n  \/\/ [^\n]*\n  if \(!ctx\) return <AdminOnlyNotice \/>\n/, f)
      assert.doesNotMatch(src, /requireStockPage|redirect\(/, `${f} : aucune redirection dans la page`)
    }
    const access = readFileSync("src/lib/stock/access.ts", "utf8")
    assert.doesNotMatch(access, /redirect\("\/dashboard"\)/, "plus aucune redirection vers /dashboard dans la garde")
    const notice = readFileSync("src/components/stock/AdminOnlyNotice.tsx", "utf8")
    assert.match(notice, /role="alert"/)
    assert.doesNotMatch(notice, /"use client"|prisma|@\/lib\//, "refus sans composant client ni accès aux données")
    const actions = readFileSync("src/lib/actions/stock.actions.ts", "utf8")
    assert.match(actions, /^"use server"/)
    assert.match(actions, /const ctx = await requireStockAdmin\(\)/)
    // Revue indépendante : aucun identifiant d'entreprise lu du formulaire, sous quelque forme que ce soit.
    assert.doesNotMatch(actions, /(form\.get|str|optId|reqId)\(\s*form\s*,?\s*["'`]companyId|form\.get\(["'`]companyId/)
    assert.doesNotMatch(actions, /["'`]companyId["'`]/)
  })
})
