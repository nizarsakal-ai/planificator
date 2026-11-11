/**
 * Client et événement saisis à la main (client particulier, hors chantier existant), depuis Stock ou Matériel.
 * Crée (ou réutilise, même nom) le client, puis un chantier « événement » rattaché, pour que le mouvement, la
 * réservation et le contrat de location reprennent automatiquement le client. Borné à l'entreprise de la session.
 */
import type { PrismaClient } from "@prisma/client"

type Db = PrismaClient
type Ctx = { companyId: string; userId: string }
export const NEW_EVENT = "__nouveau__"

const clean = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max)

export type QuickEventInput = { clientName: string; phone: string; email: string; address: string; eventName: string }

export function readQuickEvent(form: FormData): QuickEventInput {
  return {
    clientName: clean(form.get("newClientName"), 160), phone: clean(form.get("newClientPhone"), 40),
    email: clean(form.get("newClientEmail"), 160), address: clean(form.get("newClientAddress"), 300), eventName: clean(form.get("newEventName"), 160),
  }
}

export function validateQuickEvent(i: QuickEventInput): string | null {
  if (!i.clientName) return "Indiquez le nom du client."
  if (i.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.email)) return "E-mail du client invalide."
  return null
}

/** Crée le client (ou réutilise celui du même nom) et l'événement ; retourne l'identifiant du chantier créé. */
export async function createQuickEvent(db: Db, ctx: Ctx, i: QuickEventInput, period?: { first: Date; last: Date } | null): Promise<{ ok: true; worksiteId: string } | { ok: false; error: string }> {
  const err = validateQuickEvent(i)
  if (err) return { ok: false, error: err }
  return db.$transaction(async (tx) => {
    const existing = await tx.client.findFirst({ where: { companyId: ctx.companyId, active: true, name: { equals: i.clientName, mode: "insensitive" } }, select: { id: true } })
    const client = existing ?? await tx.client.create({
      data: { companyId: ctx.companyId, name: i.clientName, phone: i.phone || null, email: i.email || null, address: i.address || null, notes: "Client particulier créé depuis Stock / Matériel." },
      select: { id: true },
    })
    const w = await tx.worksite.create({
      data: {
        companyId: ctx.companyId, clientId: client.id, createdById: ctx.userId, status: "PLANNED",
        name: i.eventName || `Location – ${i.clientName}`, address: i.address || null,
        startDate: period?.first ?? null, endDate: period?.last ?? null,
      },
      select: { id: true, name: true },
    })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: w.id, action: "CREATED", entityType: "Worksite", entityId: w.id, detail: `Événement « ${w.name} » créé pour ${existing ? "le client existant" : "le nouveau client"} ${i.clientName} (saisie manuelle)` } })
    return { ok: true as const, worksiteId: w.id }
  })
}

/** Chantier choisi : existant (identifiant), nouveau client / événement saisi à la main, ou aucun. */
export async function resolveWorksite(db: Db, ctx: Ctx, form: FormData, period?: { first: Date; last: Date } | null): Promise<{ ok: true; worksiteId: string | null } | { ok: false; error: string }> {
  const v = clean(form.get("worksiteId"), 64)
  if (v === NEW_EVENT) return createQuickEvent(db, ctx, readQuickEvent(form), period)
  return { ok: true, worksiteId: v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null }
}
