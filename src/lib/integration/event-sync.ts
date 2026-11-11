/**
 * Automatisation Stock ⇄ Achats ⇄ Matériel pour le catalogue événementiel (aucune migration).
 *
 * Règles :
 *  - Article « suivi à l'unité » (tente, photobooth, sono…) : Matériel fait foi. Le stock d'un dépôt = nombre de fiches
 *    en propriété présentes dans ce dépôt (disponibles ou en entretien ; une fiche sortie est sur l'événement, une
 *    fiche réformée a quitté le parc). Chaque création, modification, sortie, retour ou réforme recalcule ce stock par
 *    un comptage d'inventaire tracé (mouvement d'ajustement motivé, jamais de stock négatif).
 *  - Réception d'achat d'un article suivi à l'unité : une fiche Matériel est créée par unité reçue, dans le dépôt de
 *    réception, puis le stock est recalculé (il reste égal au nombre de fiches).
 *  - Article « en quantité » (chaises, tables, textile, moquette…) : le stock seul fait foi (mouvements, inventaire,
 *    réceptions), sans fiche Matériel.
 * Le lien fiche ⇄ article passe par la désignation du catalogue (menu déroulant de Matériel). Toutes les écritures
 * restent bornées à l'entreprise de la session. Une synchronisation qui échoue ne remet jamais en cause l'action
 * principale : elle est journalisée et rattrapée à la prochaine synchronisation (bouton dédié).
 */
import type { PrismaClient } from "@prisma/client"
import { EVENT_STOCK_ARTICLES, eventShortCode } from "@/components/equipment/event-catalog"
import * as stock from "@/lib/stock/stock.service"
import * as equipment from "@/lib/equipment/equipment.service"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"

type Db = PrismaClient
type Ctx = { companyId: string; userId: string }
export type CatalogStockItem = (typeof EVENT_STOCK_ARTICLES)[number]

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ")

/** Élément du catalogue correspondant à une fiche Matériel (désignation, à défaut catégorie), ou null. */
export function catalogItemFor(e: { name: string; category?: string | null }): CatalogStockItem | null {
  const n = norm(e.name)
  const c = e.category ? norm(e.category) : null
  return EVENT_STOCK_ARTICLES.find((a) => norm(a.designation) === n) ?? (c ? EVENT_STOCK_ARTICLES.find((a) => norm(a.designation) === c) ?? null : null)
}

/** Élément du catalogue correspondant à un article de stock (référence EVT-, à défaut désignation). */
export function catalogItemForArticle(a: { reference: string | null; designation: string }): CatalogStockItem | null {
  return EVENT_STOCK_ARTICLES.find((i) => i.reference === a.reference) ?? EVENT_STOCK_ARTICLES.find((i) => norm(i.designation) === norm(a.designation)) ?? null
}

/** Quantité attendue en stock par dépôt pour un article suivi à l'unité (fiches présentes au dépôt). */
export function expectedUnitsByWarehouse(fiches: { warehouseId: string | null; status: string; ownership: string }[]): Map<string, number> {
  const by = new Map<string, number>()
  for (const f of fiches) {
    if (f.ownership !== "OWNED" || !f.warehouseId || (f.status !== "AVAILABLE" && f.status !== "MAINTENANCE")) continue
    by.set(f.warehouseId, (by.get(f.warehouseId) ?? 0) + 1)
  }
  return by
}

const enabled = () => isStockPurchasingEnabled() && isEquipmentRentalEnabled()

/** Recalcule le stock d'un article suivi à l'unité à partir des fiches Matériel. Retourne le nombre de dépôts ajustés. */
export async function syncTrackedItem(db: Db, ctx: Ctx, item: CatalogStockItem, cause: string): Promise<number> {
  if (!item.tracked || !enabled()) return 0
  const all = await db.equipment.findMany({ where: { companyId: ctx.companyId }, select: { name: true, category: true, warehouseId: true, status: true, ownership: true } })
  const fiches = all.filter((f) => catalogItemFor(f)?.reference === item.reference)
  const articleId = await stock.ensureEventArticle(db, ctx, item)
  const expected = expectedUnitsByWarehouse(fiches)
  const levels = await db.stockLevel.findMany({ where: { companyId: ctx.companyId, articleId }, select: { warehouseId: true, quantityMilli: true } })
  const warehouses = new Set([...expected.keys(), ...levels.map((l) => l.warehouseId)])
  const active = new Set((await db.warehouse.findMany({ where: { companyId: ctx.companyId, active: true, id: { in: [...warehouses] } }, select: { id: true } })).map((w) => w.id))
  let adjusted = 0
  for (const w of warehouses) {
    if (!active.has(w)) continue
    const want = (expected.get(w) ?? 0) * 1000
    if ((levels.find((l) => l.warehouseId === w)?.quantityMilli ?? 0) === want) continue
    const r = await stock.recordInventoryCount(db, ctx, { warehouseId: w, articleId, countedMilli: want, reason: `Synchronisation Matériel : ${cause}`.slice(0, 200) })
    if (r.ok && r.value) adjusted++
  }
  return adjusted
}

/** Désignation et catégorie actuelles d'une fiche (avant modification), bornées à l'entreprise de la session. */
export async function equipmentDesignation(db: Db, ctx: Ctx, equipmentId: string) {
  return db.equipment.findFirst({ where: { id: equipmentId, companyId: ctx.companyId }, select: { name: true, category: true } })
}

/** Après une action Matériel : resynchronise l'article de la fiche (et celui d'avant si la désignation a changé). */
export async function afterEquipmentChange(db: Db, ctx: Ctx, equipmentId: string, cause: string, previous?: { name: string; category: string } | null) {
  try {
    const e = await db.equipment.findFirst({ where: { id: equipmentId, companyId: ctx.companyId }, select: { number: true, name: true, category: true } })
    if (!e) return
    const items = new Map<string, CatalogStockItem>()
    for (const src of [e, previous]) { const it = src && catalogItemFor(src); if (it) items.set(it.reference, it) }
    for (const it of items.values()) await syncTrackedItem(db, ctx, it, `${e.number} ${cause}`)
  } catch (err) {
    console.error("[event-sync] synchronisation Matériel → Stock en échec", err instanceof Error ? err.name : "erreur")
  }
}

/** Prochains n° internes libres pour un code (« TENTE-3X3-001 », « TENTE-3X3-002 »…), bornés à l'entreprise. */
export async function nextEquipmentNumbers(db: Db, companyId: string, code: string, count: number): Promise<string[]> {
  const prefix = code.slice(0, 34).replace(/-+$/, "") || "MAT"
  const taken = new Set((await db.equipment.findMany({ where: { companyId, number: { startsWith: `${prefix}-` } }, select: { number: true } })).map((n) => n.number))
  const out: string[] = []
  for (let i = 1; out.length < count && i < 100000; i++) {
    const n = `${prefix}-${String(i).padStart(3, "0")}`
    if (!taken.has(n)) out.push(n)
  }
  return out
}

/**
 * Création en un geste depuis Matériel : un article du catalogue + une quantité + un dépôt.
 *  - suivi à l'unité : une fiche par unité, désignation, catégorie et n° interne générés (« TENTE-3X3-004 »),
 *    puis stock du dépôt aligné ;
 *  - en quantité (chaises, textile…) : entrée en stock de la quantité dans le dépôt, sans fiche.
 */
export async function createFromCatalog(db: Db, ctx: Ctx, input: {
  item: CatalogStockItem; quantity: number; warehouseId: string | null; ownership: "OWNED" | "RENTED"
  serialNumber?: string | null; dailyCostCents?: number | null; notes?: string | null
}): Promise<{ ok: true; kind: "fiches"; ids: string[]; numbers: string[] } | { ok: true; kind: "stock"; quantity: number } | { ok: false; error: string }> {
  const { item } = input
  const quantity = Math.floor(input.quantity)
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 200) return { ok: false, error: "Quantité invalide (1 à 200)." }
  if (!item.tracked) {
    if (!input.warehouseId) return { ok: false, error: `${item.designation} se gère en quantité : choisissez le dépôt où l'entrer en stock.` }
    const articleId = await stock.ensureEventArticle(db, ctx, item)
    const r = await stock.recordMovement(db, ctx, { type: "RECEIPT", quantityMilli: quantity * 1000, toWarehouseId: input.warehouseId, articleId, reason: "Entrée depuis Matériel" })
    return r.ok ? { ok: true, kind: "stock", quantity } : r
  }
  if (quantity > 1 && input.serialNumber) return { ok: false, error: "Un n° de série ne s'applique qu'à une seule fiche (quantité 1)." }
  const numbers = await nextEquipmentNumbers(db, ctx.companyId, item.code, quantity)
  const ids: string[] = []
  for (const number of numbers) {
    const r = await equipment.createEquipment(db, ctx, {
      number, name: item.designation, category: item.category, serialNumber: input.serialNumber ?? null, ownership: input.ownership,
      warehouseId: input.warehouseId, dailyCostCents: input.dailyCostCents ?? null, notes: input.notes ?? null,
    })
    if (!r.ok) { if (ids.length === 0) return r; break }
    ids.push(r.value.id)
  }
  try { await syncTrackedItem(db, ctx, item, `${ids.length} fiche(s) créée(s)`) } catch (err) {
    console.error("[event-sync] synchronisation Matériel → Stock en échec", err instanceof Error ? err.name : "erreur")
  }
  return { ok: true, kind: "fiches", ids, numbers: numbers.slice(0, ids.length) }
}

/**
 * Après une réception d'achat : une fiche Matériel par unité reçue d'un article suivi à l'unité, dans le dépôt de
 * réception, puis recalcul du stock. Retourne le nombre de fiches créées.
 */
export async function afterGoodsReceipt(db: Db, ctx: Ctx, receiptId: string): Promise<number> {
  if (!enabled()) return 0
  try {
    const receipt = await db.goodsReceipt.findFirst({
      where: { id: receiptId, companyId: ctx.companyId },
      select: { number: true, warehouseId: true, lines: { select: { quantityMilli: true, orderLine: { select: { unitPriceCents: true, article: { select: { reference: true, designation: true } } } } } } },
    })
    if (!receipt) return 0
    let created = 0
    const touched = new Map<string, CatalogStockItem>()
    for (const l of receipt.lines) {
      const a = l.orderLine.article
      const item = a ? catalogItemForArticle(a) : null
      if (!item?.tracked) continue
      const units = Math.min(500, Math.floor(l.quantityMilli / 1000))
      for (const number of await nextEquipmentNumbers(db, ctx.companyId, item.code, units)) {
        const r = await equipment.createEquipment(db, ctx, {
          number, name: item.designation, category: item.category, ownership: "OWNED", warehouseId: receipt.warehouseId,
          notes: `Créé automatiquement à la réception ${receipt.number}.`,
        })
        if (r.ok) created++
      }
      touched.set(item.reference, item)
    }
    for (const it of touched.values()) await syncTrackedItem(db, ctx, it, `réception ${receipt.number}`)
    return created
  } catch (err) {
    console.error("[event-sync] synchronisation Achats → Matériel en échec", err instanceof Error ? err.name : "erreur")
    return 0
  }
}

/** Rattrapage complet : recalcule le stock de tous les articles suivis à l'unité. Retourne le nombre d'ajustements. */
export async function syncAllTracked(db: Db, ctx: Ctx): Promise<number> {
  let n = 0
  for (const it of EVENT_STOCK_ARTICLES) if (it.tracked) n += await syncTrackedItem(db, ctx, it, "rattrapage")
  return n
}

/** N° interne automatique pour une fiche saisie librement (hors catalogue), à partir de sa désignation ou catégorie. */
export async function autoEquipmentNumber(db: Db, ctx: Ctx, label: string): Promise<string> {
  return (await nextEquipmentNumbers(db, ctx.companyId, eventShortCode(label), 1))[0]
}
