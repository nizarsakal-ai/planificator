/** Lot B Planificator V2 : lectures du matériel et de la location, toujours bornées par l'entreprise de la session. */
import type { PrismaClient } from "@prisma/client"
import { committedRentalCents, DAY_MS, maintenanceOverdue } from "@/lib/equipment/equipment.core"

type Db = PrismaClient
const STATUSES = ["AVAILABLE", "OUT", "MAINTENANCE", "RETIRED"] as const
export type EquipmentStatusFilter = (typeof STATUSES)[number]
export const isStatusFilter = (v: unknown): v is EquipmentStatusFilter => typeof v === "string" && (STATUSES as readonly string[]).includes(v)

/** Parc avec prochaine réservation active et nombre d'entretiens en retard. */
export async function listEquipment(db: Db, companyId: string, today: Date) {
  // « Prochaine » réservation : sortie en cours, ou réservation qui n'est pas terminée (revue indépendante).
  const nextWhere = { OR: [{ status: "CHECKED_OUT" as const }, { status: "RESERVED" as const, endAt: { gt: today } }] }
  const rows = await db.equipment.findMany({
    where: { companyId },
    orderBy: [{ category: "asc" }, { number: "asc" }],
    take: 1000,
    select: {
      id: true, number: true, name: true, category: true, ownership: true, status: true, condition: true,
      warehouse: { select: { name: true } },
      bookings: { where: nextWhere, orderBy: { startAt: "asc" }, take: 1, select: { startAt: true, endAt: true, status: true, worksite: { select: { name: true } } } },
      maintenances: { where: { performedOn: null }, select: { plannedOn: true, performedOn: true } },
    },
  })
  return rows.map(({ maintenances, bookings, ...e }) => ({ ...e, next: bookings[0] ?? null, overdue: maintenances.filter((m) => maintenanceOverdue(m, today)).length }))
}

export async function getEquipment(db: Db, companyId: string, id: string) {
  return db.equipment.findFirst({
    where: { id, companyId },
    select: {
      id: true, number: true, name: true, category: true, serialNumber: true, ownership: true, status: true, condition: true, dailyCostCents: true, notes: true,
      warehouse: { select: { id: true, name: true } },
      bookings: {
        orderBy: { startAt: "desc" }, take: 200,
        select: { id: true, status: true, startAt: true, endAt: true, depositCents: true, checkedOutAt: true, checkoutCondition: true, returnedAt: true, returnCondition: true, returnNotes: true, worksite: { select: { id: true, name: true } }, responsible: { select: { firstName: true, lastName: true } } },
      },
      rentals: {
        orderBy: { startDate: "desc" }, take: 100,
        select: { id: true, number: true, status: true, startDate: true, endDate: true, returnedOn: true, dailyRateCents: true, fixedFeesCents: true, costCents: true, supplierId: true, supplier: { select: { name: true } }, worksite: { select: { id: true, name: true } }, supplierInvoice: { select: { id: true, number: true, totalHTCents: true } } },
      },
      maintenances: { orderBy: [{ performedOn: { sort: "desc", nulls: "first" } }, { plannedOn: "desc" }], take: 200, select: { id: true, description: true, plannedOn: true, performedOn: true, costCents: true, supplier: { select: { name: true } } } },
    },
  })
}

/** Données des formulaires : dépôts actifs, chantiers non archivés, salariés actifs, fournisseurs actifs. */
export async function equipmentFormOptions(db: Db, companyId: string) {
  const [warehouses, worksites, employees, suppliers] = await Promise.all([
    db.warehouse.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.worksite.findMany({ where: { companyId, archivedAt: null }, orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
    db.employee.findMany({ where: { companyId, active: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }], take: 2000, select: { id: true, firstName: true, lastName: true } }),
    db.supplier.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
  ])
  return { warehouses, worksites, employees, suppliers }
}

/** Factures fournisseurs du loueur d'un contrat (rapprochement). */
export async function rentalInvoicesFor(db: Db, companyId: string, supplierId: string) {
  return db.supplierInvoice.findMany({ where: { companyId, supplierId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, number: true, totalHTCents: true } })
}

/** Contrats de location de l'entreprise, avec coût réel (clôturé) ou engagé (actif, période prévue). */
export async function listRentalContracts(db: Db, companyId: string) {
  const rows = await db.equipmentRentalContract.findMany({
    where: { companyId },
    orderBy: [{ status: "asc" }, { startDate: "desc" }],
    take: 500,
    select: { id: true, number: true, status: true, startDate: true, endDate: true, returnedOn: true, dailyRateCents: true, fixedFeesCents: true, costCents: true, equipment: { select: { id: true, number: true, name: true } }, supplier: { select: { name: true } }, worksite: { select: { id: true, name: true } }, supplierInvoice: { select: { number: true } } },
  })
  return rows.map((r) => ({ ...r, amountCents: r.status === "CLOSED" ? (r.costCents ?? BigInt("0")) : r.status === "ACTIVE" ? committedRentalCents(r) : BigInt("0") }))
}

/**
 * Coûts matériel par chantier : locations clôturées (réel), locations actives (engagé, période prévue), et coût
 * interne du matériel en propriété (jours de sortie rendus × coût journalier interne, si renseigné). Base du lot C.
 */
export async function equipmentCostsByWorksite(db: Db, companyId: string) {
  const [rentals, bookings] = await Promise.all([
    db.equipmentRentalContract.findMany({ where: { companyId, worksiteId: { not: null }, status: { in: ["ACTIVE", "CLOSED"] } }, select: { status: true, startDate: true, endDate: true, dailyRateCents: true, fixedFeesCents: true, costCents: true, worksite: { select: { id: true, name: true } } } }),
    db.equipmentBooking.findMany({ where: { companyId, worksiteId: { not: null }, status: "RETURNED", equipment: { ownership: "OWNED", dailyCostCents: { not: null } } }, select: { checkedOutAt: true, returnedAt: true, equipment: { select: { dailyCostCents: true } }, worksite: { select: { id: true, name: true } } } }),
  ])
  const by = new Map<string, { worksiteId: string; name: string; rentalActualCents: bigint; rentalCommittedCents: bigint; ownedCents: bigint }>()
  const row = (w: { id: string; name: string }) => {
    let r = by.get(w.id)
    if (!r) { r = { worksiteId: w.id, name: w.name, rentalActualCents: BigInt("0"), rentalCommittedCents: BigInt("0"), ownedCents: BigInt("0") }; by.set(w.id, r) }
    return r
  }
  for (const c of rentals) {
    if (!c.worksite) continue
    if (c.status === "CLOSED") row(c.worksite).rentalActualCents += c.costCents ?? BigInt("0")
    else row(c.worksite).rentalCommittedCents += committedRentalCents(c)
  }
  for (const b of bookings) {
    if (!b.worksite || !b.checkedOutAt || !b.returnedAt || b.equipment.dailyCostCents === null) continue
    // Jours entamés entre la sortie et le retour (au moins 1).
    const days = Math.max(1, Math.ceil((b.returnedAt.getTime() - b.checkedOutAt.getTime()) / DAY_MS))
    row(b.worksite).ownedCents += BigInt(days) * BigInt(b.equipment.dailyCostCents)
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"))
}

/** Données du contrat de location complet (document imprimable), borné à l'entreprise de la session. */
export async function getRentalContractDocumentData(db: Db, companyId: string, id: string) {
  const [contract, company] = await Promise.all([
    db.equipmentRentalContract.findFirst({
      where: { id, companyId },
      select: {
        id: true, number: true, status: true, startDate: true, endDate: true, returnedOn: true, dailyRateCents: true, fixedFeesCents: true, costCents: true, notes: true, createdAt: true,
        supplier: { select: { name: true, address: true, siret: true, vatNumber: true, email: true } },
        equipment: { select: { id: true, number: true, name: true, category: true, serialNumber: true, condition: true } },
        worksite: { select: { name: true, address: true } },
      },
    }),
    db.company.findUnique({ where: { id: companyId }, select: { name: true, address: true, siret: true, phone: true, email: true, logoUrl: true } }),
  ])
  return contract && company ? { ...contract, company } : null
}
