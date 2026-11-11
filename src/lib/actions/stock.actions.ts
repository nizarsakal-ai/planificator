"use server"
// Lot A Planificator V2 : actions serveur du stock et des achats (ADMIN de la société de session, drapeau
// STOCK_PURCHASING_ENABLED). Formulaires HTML simples : chaque action redirige vers la page avec un message
// (`?ok=` ou `?erreur=`). Le companyId vient toujours de la session ; aucun identifiant d'entreprise n'est lu du client.
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { parseEuroInputToCents } from "@/lib/billing/money"
import { StockAccessError, requireStockAdmin, stockAccessMessage, type StockContext } from "@/lib/stock/access"
import { parseQuantityToMilli } from "@/lib/stock/quantity"
import * as svc from "@/lib/stock/stock.service"
import type { MovementType } from "@/lib/stock/stock.core"
import { EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"
import { afterGoodsReceipt, syncAllTracked } from "@/lib/integration/event-sync"
import { resolveWorksite } from "@/lib/integration/quick-event"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const optId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : null }
const reqId = (f: FormData, k: string) => optId(f, k) ?? ""
const keepDepot = (f: FormData): Record<string, string> => { const d = optId(f, "depot"); return d ? { depot: d } : {} }

/** Article choisi : identifiant existant, ou « evt:RÉF » d'un élément du catalogue événementiel (créé au premier usage). */
async function articleFrom(form: FormData, key: string, ctx: StockContext): Promise<string> {
  const v = str(form, key, 80)
  if (!v.startsWith("evt:")) return v && ID.test(v) ? v : ""
  const item = EVENT_STOCK_ARTICLES.find((a) => a.reference === v.slice(4))
  return item ? svc.ensureEventArticle(prisma, ctx, item) : ""
}

function back(path: string, params: Record<string, string>, keep: Record<string, string> = {}): never {
  const q = new URLSearchParams({ ...keep, ...params }).toString()
  redirect(`${path}${q ? `?${q}` : ""}`)
}

/** Exécute une action protégée ; convertit refus d'accès et erreurs métier en message, jamais de détail technique. */
/** `keep` : paramètres d'affichage conservés au retour (filtre par dépôt de la page Stock), identifiants validés. */
async function run(path: string, fn: (ctx: StockContext) => Promise<{ ok: true; okMessage: string; redirectTo?: string } | { ok: false; error: string }>, keep: Record<string, string> = {}): Promise<never> {
  let result: { ok: true; okMessage: string; redirectTo?: string } | { ok: false; error: string }
  try {
    const ctx = await requireStockAdmin()
    result = await fn(ctx)
  } catch (e) {
    if (e instanceof StockAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof StockAccessError) back(path, { erreur: stockAccessMessage(e.reason) }, keep)
    console.error("[stock] action en échec", e instanceof Error ? e.name : "erreur")
    back(path, { erreur: "Opération impossible pour le moment." })
  }
  if (!result.ok) back(path, { erreur: result.error }, keep)
  revalidatePath("/stock", "layout")
  revalidatePath("/achats", "layout")
  back(result.redirectTo ?? path, { ok: result.okMessage }, keep)
}

export async function createWarehouseAction(form: FormData) {
  return run("/stock", async (ctx) => {
    // Lecture large puis validation par le service : un nom trop long est refusé, jamais tronqué en silence.
    const r = await svc.createWarehouse(prisma, ctx, { name: str(form, "name", 1000), address: str(form, "address", 2000) || null })
    return r.ok ? { ok: true, okMessage: "Dépôt créé." } : r
  }, keepDepot(form))
}

export async function setWarehouseActiveAction(form: FormData) {
  return run("/stock", async (ctx) => {
    const r = await svc.setWarehouseActive(prisma, ctx, reqId(form, "warehouseId"), str(form, "active") === "true")
    return r.ok ? { ok: true, okMessage: "Dépôt mis à jour." } : r
  }, keepDepot(form))
}

export async function setThresholdAction(form: FormData) {
  return run("/stock", async (ctx) => {
    const raw = str(form, "min", 20)
    const min = raw === "" ? null : parseQuantityToMilli(raw, { allowZero: true })
    if (raw !== "" && min === null) return { ok: false, error: "Seuil invalide." }
    const r = await svc.setThreshold(prisma, ctx, { warehouseId: reqId(form, "warehouseId"), articleId: await articleFrom(form, "articleId", ctx), minQuantityMilli: min })
    return r.ok ? { ok: true, okMessage: "Seuil enregistré." } : r
  }, keepDepot(form))
}

export async function recordMovementAction(form: FormData) {
  return run("/stock/mouvements", async (ctx) => {
    const type = str(form, "type", 20) as MovementType
    if (!["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT"].includes(type)) return { ok: false, error: "Type de mouvement invalide." }
    const quantityMilli = parseQuantityToMilli(str(form, "quantity", 20))
    if (quantityMilli === null) return { ok: false, error: "Quantité invalide (positive, 3 décimales au plus)." }
    // Ajustement : exactement UN des deux dépôts (départ = en moins, arrivée = en plus), sinon refus par le service ;
    // entrée : arrivée seulement ; sortie : départ seulement (le champ non pertinent est ignoré).
    const from = optId(form, "fromWarehouseId")
    const to = optId(form, "toWarehouseId")
    const site = await resolveWorksite(prisma, ctx, form)
    if (!site.ok) return site
    const r = await svc.recordMovement(prisma, ctx, {
      type, quantityMilli, articleId: await articleFrom(form, "articleId", ctx), worksiteId: site.worksiteId, reason: str(form, "reason") || null,
      fromWarehouseId: type === "RECEIPT" ? null : from,
      toWarehouseId: type === "ISSUE" ? null : to,
    })
    return r.ok ? { ok: true, okMessage: "Mouvement enregistré." } : r
  })
}

export async function inventoryCountAction(form: FormData) {
  return run("/stock", async (ctx) => {
    const counted = parseQuantityToMilli(str(form, "counted", 20), { allowZero: true })
    if (counted === null) return { ok: false, error: "Quantité comptée invalide." }
    const r = await svc.recordInventoryCount(prisma, ctx, { warehouseId: reqId(form, "warehouseId"), articleId: await articleFrom(form, "articleId", ctx), countedMilli: counted, reason: str(form, "reason") })
    return r.ok ? { ok: true, okMessage: r.value ? "Inventaire enregistré (écart ajusté)." : "Inventaire conforme : aucun écart." } : r
  }, keepDepot(form))
}

export async function createPurchaseOrderAction(form: FormData) {
  return run("/achats", async (ctx) => {
    const lines: svc.PurchaseOrderLineInput[] = []
    for (let i = 0; i < 50; i++) {
      const articleId = (await articleFrom(form, `line${i}_article`, ctx)) || null
      const designation = str(form, `line${i}_designation`)
      const q = str(form, `line${i}_quantity`, 20)
      if (!articleId && !designation && !q) continue
      const quantityMilli = parseQuantityToMilli(q)
      // Prix vide : prix de l'article (refus si la ligne n'a pas d'article) ; jamais un 0 € implicite.
      const rawPrice = str(form, `line${i}_price`, 20)
      let unitPriceCents: number | null = null
      if (rawPrice !== "") {
        try { unitPriceCents = Number(parseEuroInputToCents(rawPrice)) } catch { return { ok: false, error: `Prix unitaire invalide (ligne ${i + 1}).` } }
      }
      if (quantityMilli === null) return { ok: false, error: `Quantité invalide (ligne ${i + 1}).` }
      lines.push({ articleId, designation, quantityMilli, unitPriceCents })
    }
    const expected = str(form, "expectedAt", 10)
    let expectedAt: Date | null = null
    if (expected) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(expected) ? new Date(`${expected}T00:00:00.000Z`) : null
      if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== expected) return { ok: false, error: "Date de livraison invalide." }
      expectedAt = d
    }
    const r = await svc.createPurchaseOrder(prisma, ctx, {
      supplierId: reqId(form, "supplierId"), warehouseId: reqId(form, "warehouseId"), worksiteId: optId(form, "worksiteId"),
      expectedAt, notes: str(form, "notes", 2000) || null, lines,
    })
    return r.ok ? { ok: true, okMessage: `Commande ${r.value.number} créée.`, redirectTo: `/achats/${r.value.id}` } : r
  })
}

export async function markOrderedAction(form: FormData) {
  const id = reqId(form, "orderId")
  return run(`/achats/${id}`, async (ctx) => {
    const r = await svc.markOrdered(prisma, ctx, id)
    return r.ok ? { ok: true, okMessage: "Commande passée." } : r
  })
}

export async function cancelOrderAction(form: FormData) {
  const id = reqId(form, "orderId")
  return run(`/achats/${id}`, async (ctx) => {
    const r = await svc.cancelOrder(prisma, ctx, id)
    return r.ok ? { ok: true, okMessage: "Commande annulée." } : r
  })
}

export async function receiveGoodsAction(form: FormData) {
  const id = reqId(form, "orderId")
  return run(`/achats/${id}`, async (ctx) => {
    const lines = []
    for (const key of form.keys()) {
      const m = /^recv_([A-Za-z0-9_-]{1,64})$/.exec(key)
      if (!m) continue
      const raw = str(form, key, 20)
      if (raw === "") continue
      const q = parseQuantityToMilli(raw, { allowZero: true })
      if (q === null) return { ok: false, error: "Quantité reçue invalide." }
      lines.push({ orderLineId: m[1], quantityMilli: q })
    }
    const r = await svc.receiveGoods(prisma, ctx, id, { lines, warehouseId: optId(form, "warehouseId"), supplierInvoiceId: optId(form, "supplierInvoiceId"), notes: str(form, "notes", 2000) || null })
    if (!r.ok) return r
    const fiches = await afterGoodsReceipt(prisma, ctx, r.value.id)
    return { ok: true, okMessage: `Réception ${r.value.number} enregistrée${fiches ? ` : ${fiches} fiche(s) Matériel créée(s) automatiquement` : ""}.` }
  })
}

export async function linkSupplierInvoiceAction(form: FormData) {
  const id = reqId(form, "orderId")
  return run(`/achats/${id}`, async (ctx) => {
    const r = await svc.linkSupplierInvoice(prisma, ctx, reqId(form, "receiptId"), optId(form, "supplierInvoiceId"))
    return r.ok ? { ok: true, okMessage: "Rapprochement mis à jour." } : r
  })
}

export async function importEventCatalogAction(form: FormData) {
  return run("/stock", async (ctx) => {
    const r = await svc.importEventCatalog(prisma, ctx, EVENT_STOCK_ARTICLES)
    if (!r.ok) return r
    const { created, reactivated } = r.value
    return { ok: true, okMessage: created || reactivated ? `Catalogue événementiel : ${created} article(s) ajouté(s)${reactivated ? `, ${reactivated} réactivé(s)` : ""}. Prix à renseigner dans Articles.` : "Le catalogue événementiel est déjà présent." }
  }, keepDepot(form))
}

export async function syncEquipmentStockAction(form: FormData) {
  return run("/stock", async (ctx) => {
    const n = await syncAllTracked(prisma, ctx)
    return { ok: true, okMessage: n ? `Stock aligné sur le Matériel : ${n} ajustement(s) tracé(s).` : "Stock déjà aligné sur le Matériel." }
  }, keepDepot(form))
}
