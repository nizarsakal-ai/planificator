/** Lot A Planificator V2 : lectures du stock et des achats, toujours bornées par l'entreprise de la session. */
import type { PrismaClient } from "@prisma/client"
import { belowThreshold } from "@/lib/stock/stock.core"

type Db = PrismaClient

export async function listWarehouses(db: Db, companyId: string) {
  return db.warehouse.findMany({ where: { companyId }, orderBy: [{ active: "desc" }, { name: "asc" }], select: { id: true, name: true, address: true, active: true } })
}

/** Niveaux de stock par article et par dépôt, avec alerte de seuil. Filtre facultatif par dépôt. */
export async function listStockLevels(db: Db, companyId: string, warehouseId?: string | null) {
  const rows = await db.stockLevel.findMany({
    where: { companyId, ...(warehouseId ? { warehouseId } : {}) },
    orderBy: [{ article: { designation: "asc" } }, { warehouse: { name: "asc" } }],
    take: 1000,
    select: {
      id: true, quantityMilli: true, minQuantityMilli: true,
      article: { select: { id: true, reference: true, designation: true, unit: true } },
      warehouse: { select: { id: true, name: true, active: true } },
    },
  })
  return rows.map((r) => ({ ...r, alert: belowThreshold(r.quantityMilli, r.minQuantityMilli) }))
}

export async function listMovements(db: Db, companyId: string, opts: { take?: number; worksiteId?: string | null } = {}) {
  return db.stockMovement.findMany({
    where: { companyId, ...(opts.worksiteId ? { worksiteId: opts.worksiteId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(opts.take ?? 100, 1), 500),
    select: {
      id: true, type: true, quantityMilli: true, reason: true, createdAt: true,
      article: { select: { designation: true, unit: true } },
      fromWarehouse: { select: { name: true } }, toWarehouse: { select: { name: true } },
      worksite: { select: { id: true, name: true } },
    },
  })
}

/** Données des formulaires : articles actifs, chantiers non archivés, fournisseurs actifs, dépôts actifs. */
export async function stockFormOptions(db: Db, companyId: string) {
  const [articles, worksites, suppliers, warehouses] = await Promise.all([
    db.article.findMany({ where: { companyId, active: true }, orderBy: { designation: "asc" }, take: 2000, select: { id: true, reference: true, designation: true, unit: true, unitPrice: true } }),
    db.worksite.findMany({ where: { companyId, archivedAt: null }, orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
    db.supplier.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, take: 2000, select: { id: true, name: true } }),
    db.warehouse.findMany({ where: { companyId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ])
  return { articles, worksites, suppliers, warehouses }
}

export async function listPurchaseOrders(db: Db, companyId: string) {
  return db.purchaseOrder.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, number: true, status: true, totalHTCents: true, expectedAt: true, createdAt: true, supplier: { select: { name: true } }, warehouse: { select: { name: true } }, worksite: { select: { name: true } } },
  })
}

export async function getPurchaseOrder(db: Db, companyId: string, id: string) {
  return db.purchaseOrder.findFirst({
    where: { id, companyId },
    select: {
      id: true, number: true, status: true, totalHTCents: true, expectedAt: true, orderedAt: true, notes: true, supplierId: true,
      supplier: { select: { name: true } }, warehouse: { select: { id: true, name: true } }, worksite: { select: { id: true, name: true } },
      lines: { orderBy: { position: "asc" }, select: { id: true, designation: true, quantityMilli: true, receivedMilli: true, unitPriceCents: true, article: { select: { unit: true, reference: true } } } },
      receipts: { orderBy: { receivedAt: "asc" }, select: { id: true, number: true, receivedAt: true, warehouse: { select: { name: true } }, supplierInvoice: { select: { id: true, number: true } }, lines: { select: { quantityMilli: true, orderLine: { select: { designation: true } } } } } },
    },
  })
}

/** Factures fournisseurs du même fournisseur, pour le rapprochement (les plus récentes). */
export async function supplierInvoicesFor(db: Db, companyId: string, supplierId: string) {
  return db.supplierInvoice.findMany({ where: { companyId, supplierId }, orderBy: { date: "desc" }, take: 100, select: { id: true, number: true, date: true, totalHTCents: true } })
}
