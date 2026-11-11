"use server"
// Lot B Planificator V2 : actions serveur du matériel et de la location (ADMIN de la société de session, drapeau
// EQUIPMENT_RENTAL_ENABLED). Formulaires HTML simples : chaque action redirige vers la page avec un message
// (`?ok=` ou `?erreur=`). Le companyId vient toujours de la session ; aucun identifiant d'entreprise n'est lu du client.
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { parseEuroInputToCents } from "@/lib/billing/money"
import { EquipmentAccessError, equipmentAccessMessage, requireEquipmentAdmin, type EquipmentContext } from "@/lib/equipment/access"
import { parseDay } from "@/lib/equipment/equipment.core"
import * as svc from "@/lib/equipment/equipment.service"
import { afterEquipmentChange, autoEquipmentNumber, createFromCatalog, equipmentDesignation } from "@/lib/integration/event-sync"
import { EVENT_STOCK_ARTICLES } from "@/components/equipment/event-catalog"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").trim().slice(0, max)
const optId = (f: FormData, k: string) => { const v = str(f, k, 64); return v && ID.test(v) ? v : null }
const reqId = (f: FormData, k: string) => optId(f, k) ?? ""

/** Montant en euros saisi → centimes ; "" → null ; invalide ou hors colonne INTEGER → "invalide". */
function euros(raw: string): number | null | "invalide" {
  if (raw === "") return null
  try {
    const c = parseEuroInputToCents(raw)
    return c >= BigInt("0") && c <= BigInt("2000000000") ? Number(c) : "invalide"
  } catch { return "invalide" }
}
/** Jour saisi (« AAAA-MM-JJ ») ; "" → null ; date inexistante → "invalide". */
function day(raw: string): Date | null | "invalide" {
  if (raw === "") return null
  return parseDay(raw) ?? "invalide"
}

type Outcome = { ok: true; okMessage: string; redirectTo?: string } | { ok: false; error: string }

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString()
  redirect(`${path}${q ? `?${q}` : ""}`)
}

/** Exécute une action protégée ; convertit refus d'accès et erreurs métier en message, jamais de détail technique. */
async function run(path: string, fn: (ctx: EquipmentContext) => Promise<Outcome>): Promise<never> {
  let result: Outcome
  try {
    const ctx = await requireEquipmentAdmin()
    result = await fn(ctx)
  } catch (e) {
    if (e instanceof EquipmentAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof EquipmentAccessError) back(path, { erreur: equipmentAccessMessage(e.reason) })
    console.error("[materiel] action en échec", e instanceof Error ? e.name : "erreur")
    back(path, { erreur: "Opération impossible pour le moment." })
  }
  if (!result.ok) back(path, { erreur: result.error })
  revalidatePath("/materiel", "layout")
  back(result.redirectTo ?? path, { ok: result.okMessage })
}
const detail = (f: FormData) => { const id = reqId(f, "equipmentId"); return { id, path: id ? `/materiel/${id}` : "/materiel" } }

export async function createEquipmentAction(form: FormData) {
  return run("/materiel", async (ctx) => {
    const cost = euros(str(form, "dailyCost", 20))
    if (cost === "invalide") return { ok: false, error: "Coût journalier invalide." }
    const ownership = str(form, "ownership", 10) === "RENTED" ? "RENTED" : "OWNED"
    const quantity = Number(str(form, "quantity", 6) || "1")
    const serialNumber = str(form, "serialNumber", 1000) || null
    const notes = str(form, "notes", 5000) || null
    const warehouseId = optId(form, "warehouseId")
    const manualNumber = str(form, "number", 200)
    const item = EVENT_STOCK_ARTICLES.find((a) => a.reference === str(form, "catalogRef", 80))
    // Article du catalogue, sans n° imposé : création automatique (fiches numérotées, ou entrée en stock si géré en quantité).
    if (item && !manualNumber) {
      const r = await createFromCatalog(prisma, ctx, { item, quantity, warehouseId, ownership, serialNumber, dailyCostCents: cost, notes })
      if (!r.ok) return r
      if (r.kind === "stock") return { ok: true, okMessage: `${r.quantity} × ${item.designation} entré(s) en stock.`, redirectTo: "/stock" }
      return { ok: true, okMessage: r.ids.length === 1 ? `Fiche ${r.numbers[0]} créée (stock mis à jour).` : `${r.ids.length} fiches créées : ${r.numbers[0]} à ${r.numbers.at(-1)} (stock mis à jour).`, redirectTo: r.ids.length === 1 ? `/materiel/${r.ids[0]}` : "/materiel" }
    }
    if (quantity !== 1 && manualNumber) return { ok: false, error: "Un n° interne imposé ne vaut que pour une seule fiche : laissez-le vide pour une quantité." }
    const name = item?.designation ?? str(form, "name", 1000)
    const category = item?.category ?? str(form, "category", 1000)
    // Lecture large puis validation par le service : une saisie trop longue est refusée, jamais tronquée en silence.
    const r = await svc.createEquipment(prisma, ctx, {
      number: manualNumber || await autoEquipmentNumber(prisma, ctx, category || name), name, category,
      serialNumber, ownership, warehouseId, dailyCostCents: cost, notes,
    })
    if (r.ok) await afterEquipmentChange(prisma, ctx, r.value.id, "créé")
    return r.ok ? { ok: true, okMessage: "Équipement créé (stock mis à jour).", redirectTo: `/materiel/${r.value.id}` } : r
  })
}

export async function updateEquipmentAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const cost = euros(str(form, "dailyCost", 20))
    if (cost === "invalide") return { ok: false, error: "Coût journalier invalide." }
    const previous = await equipmentDesignation(prisma, ctx, id)
    const r = await svc.updateEquipment(prisma, ctx, id, {
      name: str(form, "name", 1000), category: str(form, "category", 1000), serialNumber: str(form, "serialNumber", 1000) || null,
      warehouseId: optId(form, "warehouseId"), dailyCostCents: cost, notes: str(form, "notes", 5000) || null,
    })
    if (r.ok) await afterEquipmentChange(prisma, ctx, id, "fiche modifiée", previous)
    return r.ok ? { ok: true, okMessage: "Fiche enregistrée." } : r
  })
}

export async function setEquipmentStatusAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const r = await svc.setEquipmentStatus(prisma, ctx, id, str(form, "status", 20))
    if (r.ok) await afterEquipmentChange(prisma, ctx, id, "changement d'état")
    return r.ok ? { ok: true, okMessage: "État mis à jour." } : r
  })
}

export async function createBookingAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const first = day(str(form, "firstDay", 10))
    const last = day(str(form, "lastDay", 10))
    if (!first || !last || first === "invalide" || last === "invalide") return { ok: false, error: "Dates de réservation invalides." }
    const deposit = euros(str(form, "deposit", 20))
    if (deposit === "invalide") return { ok: false, error: "Caution invalide." }
    const r = await svc.createBooking(prisma, ctx, { equipmentId: id, firstDay: first, lastDay: last, worksiteId: optId(form, "worksiteId"), responsibleEmployeeId: optId(form, "responsibleId"), depositCents: deposit })
    return r.ok ? { ok: true, okMessage: "Réservation enregistrée : contrat de location établi automatiquement.", redirectTo: `/materiel/reservations/${r.value.id}/contrat` } : r
  })
}

export async function checkoutBookingAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const bookingId = reqId(form, "bookingId")
    const r = await svc.checkoutBooking(prisma, ctx, bookingId, str(form, "condition", 20))
    if (r.ok) await afterEquipmentChange(prisma, ctx, id, "sorti")
    return r.ok ? { ok: true, okMessage: "Sortie enregistrée : contrat de location à jour (état à la sortie).", redirectTo: `/materiel/reservations/${bookingId}/contrat` } : r
  })
}

export async function returnBookingAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const r = await svc.returnBooking(prisma, ctx, reqId(form, "bookingId"), { condition: str(form, "condition", 20), notes: str(form, "notes", 5000) || null, warehouseId: optId(form, "warehouseId") })
    if (r.ok) await afterEquipmentChange(prisma, ctx, id, "rentré")
    return r.ok ? { ok: true, okMessage: r.value.nextStatus === "MAINTENANCE" ? "Retour enregistré : équipement endommagé, passé en entretien." : "Retour enregistré." } : r
  })
}

export async function cancelBookingAction(form: FormData) {
  const { path } = detail(form)
  return run(path, async (ctx) => {
    const r = await svc.cancelBooking(prisma, ctx, reqId(form, "bookingId"))
    return r.ok ? { ok: true, okMessage: "Réservation annulée." } : r
  })
}

export async function createRentalContractAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const start = day(str(form, "startDate", 10))
    const end = day(str(form, "endDate", 10))
    if (!start || !end || start === "invalide" || end === "invalide") return { ok: false, error: "Dates du contrat invalides." }
    const rate = euros(str(form, "dailyRate", 20))
    const fees = euros(str(form, "fixedFees", 20))
    if (rate === null || rate === "invalide") return { ok: false, error: "Tarif journalier invalide." }
    if (fees === "invalide") return { ok: false, error: "Frais fixes invalides." }
    const r = await svc.createRentalContract(prisma, ctx, { equipmentId: id, supplierId: reqId(form, "supplierId"), worksiteId: optId(form, "worksiteId"), startDate: start, endDate: end, dailyRateCents: rate, fixedFeesCents: fees ?? 0, notes: str(form, "notes", 5000) || null })
    return r.ok ? { ok: true, okMessage: `Contrat ${r.value.number} enregistré : contrat complet prêt à imprimer.`, redirectTo: `/materiel/locations/${r.value.id}/contrat` } : r
  })
}

export async function closeRentalContractAction(form: FormData) {
  const { path } = detail(form)
  return run(path, async (ctx) => {
    const returned = day(str(form, "returnedOn", 10))
    if (!returned || returned === "invalide") return { ok: false, error: "Date de retour invalide." }
    const r = await svc.closeRentalContract(prisma, ctx, reqId(form, "contractId"), returned)
    return r.ok ? { ok: true, okMessage: "Contrat clôturé, coût figé." } : r
  })
}

export async function cancelRentalContractAction(form: FormData) {
  const { path } = detail(form)
  return run(path, async (ctx) => {
    const r = await svc.cancelRentalContract(prisma, ctx, reqId(form, "contractId"))
    return r.ok ? { ok: true, okMessage: "Contrat annulé." } : r
  })
}

export async function linkRentalInvoiceAction(form: FormData) {
  const { path } = detail(form)
  return run(path, async (ctx) => {
    const r = await svc.linkRentalInvoice(prisma, ctx, reqId(form, "contractId"), optId(form, "supplierInvoiceId"))
    return r.ok ? { ok: true, okMessage: "Facture fournisseur mise à jour." } : r
  })
}

export async function recordMaintenanceAction(form: FormData) {
  const { id, path } = detail(form)
  return run(path, async (ctx) => {
    const planned = day(str(form, "plannedOn", 10))
    const performed = day(str(form, "performedOn", 10))
    if (planned === "invalide" || performed === "invalide") return { ok: false, error: "Date d'entretien invalide." }
    const cost = euros(str(form, "cost", 20))
    if (cost === "invalide") return { ok: false, error: "Coût invalide." }
    const r = await svc.recordMaintenance(prisma, ctx, { equipmentId: id, description: str(form, "description", 2000), plannedOn: planned, performedOn: performed, costCents: cost, supplierId: optId(form, "supplierId") })
    return r.ok ? { ok: true, okMessage: "Entretien enregistré." } : r
  })
}

export async function completeMaintenanceAction(form: FormData) {
  const { path } = detail(form)
  return run(path, async (ctx) => {
    const performed = day(str(form, "performedOn", 10))
    if (!performed || performed === "invalide") return { ok: false, error: "Date de réalisation invalide." }
    const cost = euros(str(form, "cost", 20))
    if (cost === "invalide") return { ok: false, error: "Coût invalide." }
    const r = await svc.completeMaintenance(prisma, ctx, reqId(form, "maintenanceId"), { performedOn: performed, costCents: cost })
    return r.ok ? { ok: true, okMessage: "Entretien réalisé." } : r
  })
}
