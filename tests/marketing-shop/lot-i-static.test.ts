/**
 * Lot I Planificator V2 : contrôles statiques (aucune base).
 * - Migration unique et additive : seulement les types et tables du lot I ; clés composites vers `articles` et `clients` ;
 *   aucune cascade ; CHECK, déclencheurs (immuabilité, totaux différés, consentement relu sous verrou partagé).
 * - Périmètre : aucun devis, facture, stock, connecteur, prestataire ni appel réseau ; journal sans donnée personnelle libre.
 * - Gardes : refus sur place avant toute lecture ; actions gardées ; aucun companyId ni prix lu du formulaire.
 * - Retours E4 : listes I distinctes et bornées ; fiches CRM et pages E inchangées ; entrées sans troncature.
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { adresseApresSucces, retour, RETOUR_INITIAL } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const MIGRATION_DIR = "20261119150000_v2_lot_i_marketing_shop"
const sql = read(`prisma/migrations/${MIGRATION_DIR}/migration.sql`)
const schema = read("prisma/schema.prisma")
const NEW_TABLES = ["marketing_sources", "marketing_campaigns", "marketing_consents", "shop_promotions", "shop_orders", "shop_order_lines", "marketing_conversions"]
const PAGES = ["src/app/(dashboard)/marketing/page.tsx", "src/app/(dashboard)/boutique/page.tsx", "src/app/(dashboard)/boutique/commandes/[orderId]/page.tsx"]
const LIB = readdirSync("src/lib/marketing-shop").map((f) => `src/lib/marketing-shop/${f}`)
const ACTIONS = "src/lib/actions/marketing-shop.actions.ts"
const I_FILES = [...LIB, ACTIONS, ...PAGES]

describe("migration du lot I", () => {
  it("unique, nommée comme demandé, dernière migration du dépôt", () => {
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()
    assert.deepEqual(dirs.filter((d) => d.includes("lot_i")), [MIGRATION_DIR])
    // Dernière migration de LOT du dépôt ; les migrations ultérieures hors lots (photos, espace PDF du Studio…) ne comptent pas.
    const lots = dirs.filter((d) => /_v2_lot_/.test(d))
    assert.equal(lots[lots.length - 1], MIGRATION_DIR)
    assert.ok(dirs.includes("20261117120000_vehicle_tour_auto_km"), "dernière migration de main 90ae644 présente")
  })
  it("additive : aucun objet existant modifié, aucune donnée lue ni écrite hors déclencheurs des tables I", () => {
    const body = code(sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$").split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    assert.doesNotMatch(body, /\bDROP\b|ALTER TYPE|ALTER TABLE "(?!marketing_|shop_)/i)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/(?:BEFORE|AFTER) [A-Z ]+ ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    assert.deepEqual([...body.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort(), [...NEW_TABLES].sort())
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE|AFTER INSERT ON|BEFORE INSERT ON|BEFORE TRUNCATE ON/g, "").replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, ""), /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i)
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("clés composites entre sociétés vers les clés existantes ; aucune cascade de suppression", () => {
    for (const re of [
      /"shop_order_lines_companyId_articleId_fkey" FOREIGN KEY \("companyId", "articleId"\) REFERENCES "articles"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"shop_orders_clientId_companyId_fkey" FOREIGN KEY \("clientId", "companyId"\) REFERENCES "clients"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"marketing_consents_clientId_companyId_fkey" FOREIGN KEY \("clientId", "companyId"\) REFERENCES "clients"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"marketing_conversions_companyId_orderId_clientId_fkey" FOREIGN KEY \("companyId", "orderId", "clientId"\) REFERENCES "shop_orders"\("companyId", "id", "clientId"\)/,
      /"marketing_conversions_companyId_campaignId_fkey" FOREIGN KEY \("companyId", "campaignId"\) REFERENCES "marketing_campaigns"\("companyId", "id"\)/,
      /"marketing_conversions_companyId_clientId_fkey" FOREIGN KEY \("companyId", "clientId"\) REFERENCES "marketing_consents"\("companyId", "clientId"\)/,
      /"marketing_campaigns_companyId_sourceId_fkey" FOREIGN KEY \("companyId", "sourceId"\) REFERENCES "marketing_sources"\("companyId", "id"\)/,
      /"shop_orders_companyId_promotionId_fkey" FOREIGN KEY \("companyId", "promotionId"\) REFERENCES "shop_promotions"\("companyId", "id"\)/,
      /CREATE UNIQUE INDEX "shop_orders_companyId_idempotencyKey_key" ON "shop_orders"\("companyId", "idempotencyKey"\);/,
      /CREATE UNIQUE INDEX "marketing_conversions_companyId_orderId_key" ON "marketing_conversions"\("companyId", "orderId"\);/,
      /CREATE UNIQUE INDEX "marketing_consents_companyId_clientId_key" ON "marketing_consents"\("companyId", "clientId"\);/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    const lotI = schema.split("// Lot I Planificator V2 (19/11/2026)")[1]
    assert.ok(lotI, "marqueur du lot I")
    assert.doesNotMatch(lotI, /onDelete: Cascade/)
  })
  it("CHECK et déclencheurs : consentement jamais implicite, immuabilité, totaux différés, consentement relu sous verrou", () => {
    assert.match(sql, /"status" "MarketingConsentStatus" NOT NULL,/, "aucun défaut au consentement")
    assert.doesNotMatch(sql, /"status" "MarketingConsentStatus" NOT NULL DEFAULT/)
    assert.match(sql, /\("status" = 'GRANTED' AND "withdrawnAt" IS NULL AND "withdrawnById" IS NULL\)/)
    assert.match(sql, /"grossCents" = "quantity"::bigint \* "unitPriceCents"/)
    assert.match(sql, /"totalTTCCents" = "totalHTCents" \+ "totalVATCents"/)
    assert.match(sql, /CREATE CONSTRAINT TRIGGER shop_orders_totals_guard AFTER INSERT ON "shop_orders"\n\s+DEFERRABLE INITIALLY DEFERRED/)
    assert.match(sql, /CREATE CONSTRAINT TRIGGER shop_order_lines_totals_guard AFTER INSERT ON "shop_order_lines"\n\s+DEFERRABLE INITIALLY DEFERRED/)
    assert.match(sql, /FROM "marketing_consents" c WHERE c\."companyId" = NEW\."companyId" AND c\."clientId" = NEW\."clientId" FOR SHARE;/)
    // v2 de revue : panier figé par le nombre de lignes enregistré (1 à 20), exigé exactement à la validation.
    assert.match(sql, /"lineCount" INTEGER NOT NULL,/)
    assert.match(sql, /AND "lineCount" BETWEEN 1 AND 20/)
    assert.match(sql, /IF s\.n <> o\."lineCount" THEN\n\s+RAISE EXCEPTION 'shop order line count mismatch'/)
    assert.doesNotMatch(sql, /s\.n < 1/)
    assert.ok(read("src/lib/marketing-shop/shop.service.ts").includes("lineCount: order.lines.length,"))
    for (const m of ["shop order line count mismatch", "marketing consent not granted", "marketing conversion amount mismatch", "shop order totals mismatch", "is append-only", "marketing consent cannot be deleted", "shop promotion terms immutable"]) assert.ok(sql.includes(m), m)
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
  })
})

describe("périmètre du lot I", () => {
  it("aucun devis, facture, stock, connecteur, prestataire, paiement ni appel réseau dans le module", () => {
    for (const f of I_FILES) {
      const c = code(read(f))
      assert.doesNotMatch(c, /\b(?:tx|db|prisma)\.(?:quote|quoteLine|invoice|invoiceLine|stockLevel|stockMovement|purchaseOrder|integrationConnection|documentCounter)\b/, `${f} : aucune lecture ni écriture hors périmètre`)
      assert.doesNotMatch(c, /\b(?:tx|db|prisma)\.article\.(?:update|create|delete|upsert)/, `${f} : le catalogue n'est jamais modifié`)
      assert.doesNotMatch(c, /\b(?:tx|db|prisma)\.client\.(?:update|create|delete|upsert)/, `${f} : les clients ne sont jamais modifiés`)
      assert.doesNotMatch(c, /\bfetch\(|https?:\/\/|from "(?:stripe|nodemailer|resend|@sendgrid)|node:(?:http|https|net)"/, `${f} : aucun appel externe`)
      assert.doesNotMatch(c, /from "@\/lib\/(?:reserves|connectors|assistant|document-studio|payroll-prep|billing\/(?:quotes|invoices))/, `${f} : aucun couplage aux autres lots ni aux devis et factures`)
    }
  })
  it("journal : détails génériques (opération), sans nom de client, libellé ni montant", () => {
    for (const f of ["src/lib/marketing-shop/marketing.service.ts", "src/lib/marketing-shop/shop.service.ts"]) {
      const c = code(read(f))
      for (const m of c.matchAll(/await audit\(tx, ctx, "[A-Z_]+", "[A-Za-z]+", [^,]+, ([^)]+)\)/g)) assert.match(m[1].trim(), /^(?:MARKETING_AUDIT|SHOP_AUDIT)\.|^active \? SHOP_AUDIT\.promotionActivated : SHOP_AUDIT\.promotionDeactivated$/, `${f} : ${m[1]}`)
    }
  })
  it("v2 de revue : totaux par source agrégés en base, jointure filtrée par société ; nom réel de la source par campagne", () => {
    const q = code(read("src/lib/marketing-shop/queries.ts"))
    assert.ok(q.includes(`JOIN "marketing_campaigns" k ON k."id" = c."campaignId" AND k."companyId" = c."companyId" AND k."companyId" = \${companyId}`))
    assert.ok(q.includes(`WHERE c."companyId" = \${companyId}`))
    assert.ok(q.includes(`COALESCE(SUM(c."attributedHTCents"), 0)::bigint`))
    assert.ok(q.includes("source: { select: { name: true } }"))
    assert.ok(q.includes("take: 500") && q.includes("take: 200"), "limites d'affichage conservées")
    const core = code(read("src/lib/marketing-shop/marketing.core.ts"))
    assert.doesNotMatch(core.slice(core.indexOf("export function computeIndicators")), /byCampaign\.values\(\)\) \{\n\s+const s = bySource/, "les totaux par source ne dérivent plus des campagnes affichées")
    const page = code(read("src/app/(dashboard)/marketing/page.tsx"))
    assert.ok(page.includes("new Map(v.campaigns.map((c) => [c.id, c.source.name]))") && !page.includes("sourceName.get("))
  })
  it("prix, taux et libellés lus de l'article côté serveur ; jamais du formulaire", () => {
    const a = code(read(ACTIONS))
    assert.doesNotMatch(a, /unitPrice|vatRate|designation|companyId|totalHT|price/i)
    const s = code(read("src/lib/marketing-shop/shop.service.ts"))
    assert.ok(s.includes("select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true }"))
    assert.ok(s.includes("where: { companyId: ctx.companyId, active: true, id: { in: ids } }"))
  })
})

describe("gardes et écrans", () => {
  it("pages : refus sur place avant toute lecture ; ZoneRetour/MessageRetour ; aucun <form> brut ni next/link", () => {
    for (const f of PAGES) {
      const c = code(read(f))
      assert.match(c, /const ctx = await marketingShopPageAccess\(\)\n\s+if \(!ctx\) return <AdminOnlyNotice \/>\n/, f)
      const garde = c.indexOf("if (!ctx) return <AdminOnlyNotice />")
      for (const lecture of ["getMarketingView(", "getShopView(", "getOrder(", "await params", "await searchParams"]) { const at = c.indexOf(lecture); if (at >= 0) assert.ok(at > garde, `${f} : ${lecture}`) }
      assert.ok(c.includes("<ZoneRetour rendu={Date.now()}>") && c.includes("</ZoneRetour>"), f)
      assert.match(c, /<MessageRetour><StockFlash params=\{(?:params|sp)\} \/><\/MessageRetour>/, f)
      assert.doesNotMatch(c, /<form[\s>]|from "next\/link"|<Link[\s>]|redirect\(/, f)
    }
    assert.equal((code(read(PAGES[0])).match(/<FormulaireRetour /g) ?? []).length, 5)
    assert.equal((code(read(PAGES[1])).match(/<FormulaireRetour /g) ?? []).length, 3)
    assert.ok(code(read(PAGES[1])).includes(`<input type="hidden" name="idempotencyKey" value={idempotencyKey} />`))
    const acces = read("src/lib/marketing-shop/access.ts")
    assert.ok(acces.includes("const decision = pageDecision(r.reason)") && acces.includes("resolveStockAccessCore(enabled, session)"))
  })
  it("actions : gardées, retour par état, seule redirection /login, cible fiche de commande ; entrées sans troncature", () => {
    const a = read(ACTIONS), c = code(a)
    assert.match(a, /^"use server"/)
    assert.doesNotMatch(c, /revalidatePath|from "next\/cache"|\.slice\(0,/)
    assert.equal((c.match(/redirect\(/g) ?? []).length, 1)
    assert.ok(c.includes("result = await fn(await requireMarketingShopAdmin())"))
    const names = ["createSourceAction", "createCampaignAction", "grantConsentAction", "withdrawConsentAction", "attributeOrderAction", "createPromotionAction", "setPromotionActiveAction", "createOrderAction"]
    for (const n of names) assert.match(c, new RegExp(`export async function ${n}\\(a: RetourAction \\| FormData, b\\?: FormData\\) \\{\\n  const form = formulaireDe\\(a, b\\)\\n  return run\\(`), n)
    assert.equal((c.match(/^export async function /gm) ?? []).length, names.length)
    assert.equal((c.match(/cible: /g) ?? []).length, 1)
    assert.ok(c.includes("cible: ficheCommande(r.value.id)"))
    assert.ok(c.includes("return s.length > max ? null : s"))
  })
  it("retours : listes I exactes ; fiches CRM et pages E inchangées", () => {
    assert.equal(adresseApresSucces(retour(true, "Commande de simulation enregistrée.", "/boutique/commandes/o_1"), "/boutique"), "/boutique/commandes/o_1?ok=Commande+de+simulation+enregistr%C3%A9e.")
    for (const p of ["/marketing", "/boutique", "/boutique/commandes/o_1"]) assert.equal(adresseApresSucces(retour(true, "x"), p), `${p}?ok=x`, p)
    for (const c of ["/marketing", "/boutique", "/boutique/commandes", "/boutique/commandes/", "/boutique/commandes/a/b", `/boutique/commandes/${"a".repeat(65)}`, "/boutique/commandes/a%2Fb", "//evil.example/boutique", "https://evil.example/marketing"]) {
      assert.equal(adresseApresSucces(retour(true, "x", c), "/boutique"), null, `cible ${c}`)
    }
    for (const p of ["/marketing/", "/marketing/x", "/boutique/", "/boutique/x", "/boutiquex", "/boutique/commandes"]) assert.equal(adresseApresSucces(retour(true, "x"), p), null, `page ${p}`)
    assert.equal(adresseApresSucces(retour(false, "x"), "/marketing"), null)
    assert.equal(adresseApresSucces(RETOUR_INITIAL, "/boutique"), null)
    assert.equal(adresseApresSucces(retour(true, "x", "/crm/opportunites/c1"), "/crm/opportunites"), "/crm/opportunites/c1?ok=x")
    const src = read("src/lib/actions/retour-action.ts")
    assert.ok(src.includes("const FICHE = /^\\/crm\\/opportunites\\/[A-Za-z0-9_-]{1,64}$/"))
    assert.ok(src.includes("const PAGES_LOT_E = /^\\/(?:crm\\/opportunites(?:\\/[A-Za-z0-9_-]{1,64})?|automatisations)$/"))
  })
  it("aucun littéral BigInt (cible ES2017)", () => {
    for (const f of [...I_FILES, "tests/marketing-shop/lot-i-core.test.ts", "tests/marketing-shop/pg/marketing-shop.pg.test.ts"]) assert.doesNotMatch(code(read(f)), /\b\d[\d_]*n\b/, f)
  })
})
