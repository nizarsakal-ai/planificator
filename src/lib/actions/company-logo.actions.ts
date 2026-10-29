"use server"
// Logo d'entreprise (réglages « Identité et documents ») — ADMIN / SUPER_ADMIN de la société de session uniquement.

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { LOGO_MAX_UPLOAD_BYTES, normalizeCompanyLogo } from "@/lib/company-logo"

type Result = { ok: true; width?: number; height?: number; bytes?: number } | { ok: false; error: string }

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return { userId: session.user.id, companyId: session.user.companyId }
}

export async function uploadCompanyLogo(formData: FormData): Promise<Result> {
  let ctx: { userId: string; companyId: string }
  try { ctx = await requireAdmin() } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Accès refusé" } }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Aucun fichier sélectionné." }
  if (file.size > LOGO_MAX_UPLOAD_BYTES) return { ok: false, error: "Fichier trop volumineux (2 Mo maximum)." }

  const normalized = await normalizeCompanyLogo(Buffer.from(await file.arrayBuffer()))
  if (!normalized.ok) return normalized

  // Isolation : la société de session, et elle seule (where sur l'identifiant de session, jamais sur une entrée client).
  await prisma.$transaction(async (tx) => {
    const r = await tx.company.updateMany({ where: { id: ctx.companyId }, data: { logoUrl: normalized.dataUrl } })
    if (r.count !== 1) throw new Error("Entreprise introuvable")
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "Company", entityId: ctx.companyId, detail: `Logo importé (${normalized.sourceFormat} → PNG ${normalized.width}×${normalized.height}, ${Math.round(normalized.bytes / 1024)} Ko)` } })
  })
  revalidatePath("/parametres")
  revalidatePath("/devis", "layout")
  revalidatePath("/factures", "layout")
  return { ok: true, width: normalized.width, height: normalized.height, bytes: normalized.bytes }
}

export async function removeCompanyLogo(): Promise<Result> {
  let ctx: { userId: string; companyId: string }
  try { ctx = await requireAdmin() } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Accès refusé" } }
  await prisma.$transaction(async (tx) => {
    const r = await tx.company.updateMany({ where: { id: ctx.companyId }, data: { logoUrl: null } })
    if (r.count !== 1) throw new Error("Entreprise introuvable")
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "Company", entityId: ctx.companyId, detail: "Logo retiré" } })
  })
  revalidatePath("/parametres")
  revalidatePath("/devis", "layout")
  revalidatePath("/factures", "layout")
  return { ok: true }
}
