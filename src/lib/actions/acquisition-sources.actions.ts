"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { acquisitionPartnerAdminService } from "@/lib/acquisition/admin/partner-admin.service"
import { isPartnerAdminError } from "@/lib/acquisition/admin/partner-admin.errors"
import {
  extractDomainInput,
  partnerAdminErrorMessage,
  partnerCodeFromName,
} from "@/lib/acquisition/admin/partner-sources"

/**
 * Sources de consultations : ajout d'un expéditeur partenaire (nom + domaine)
 * depuis Paramètres. Seuls les e-mails des domaines du registre sont importés.
 * Tout est borné par le companyId de la session (jamais fourni par le client).
 */

export type SourceActionResult = { ok: true; message: string } | { ok: false; error: string }

async function requireSourcesAdmin(): Promise<{ companyId: string } | null> {
  const session = await auth()
  if (!session?.user?.companyId) return null
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) return null
  return { companyId: session.user.companyId }
}

/**
 * Relit les 30 derniers jours des boîtes au prochain run (mode lookback filtré
 * sur les partenaires) : récupère les e-mails déjà reçus du nouvel expéditeur.
 * Les e-mails déjà traités ne sont pas relus (filtre des ids connus) ; ceux qui
 * avaient été rejetés faute d'expéditeur partenaire sont promus en consultation.
 */
async function scheduleMailboxRescan(companyId: string): Promise<void> {
  await prisma.acquisitionScanCursor.updateMany({
    where: { companyId, source: "GMAIL", NOT: { mailboxKey: "" } },
    data: { lastHistoryId: null },
  })
}

export async function addConsultationSourceAction(input: {
  name: string
  domain: string
}): Promise<SourceActionResult> {
  const admin = await requireSourcesAdmin()
  if (!admin) return { ok: false, error: "Accès refusé" }

  const name = String(input?.name ?? "").trim()
  const domain = extractDomainInput(String(input?.domain ?? ""))
  if (!name) return { ok: false, error: "Indiquez le nom de l'expéditeur (ex. ATS)." }
  if (!domain) return { ok: false, error: "Indiquez le domaine e-mail (ex. ats67.com)." }

  try {
    const code = partnerCodeFromName(name, domain)
    let partner = await prisma.acquisitionPartner.findUnique({
      where: { companyId_code: { companyId: admin.companyId, code } },
      select: { id: true, active: true },
    })
    if (!partner) {
      partner = await acquisitionPartnerAdminService.createPartner({
        companyId: admin.companyId,
        name,
        code,
      })
    } else if (!partner.active) {
      await acquisitionPartnerAdminService.activatePartner({ companyId: admin.companyId, partnerId: partner.id })
    }
    await acquisitionPartnerAdminService.addDomain({
      companyId: admin.companyId,
      partnerId: partner.id,
      domain,
    })
    await scheduleMailboxRescan(admin.companyId)
  } catch (e) {
    if (isPartnerAdminError(e)) return { ok: false, error: partnerAdminErrorMessage(e.code) }
    console.error("[acquisition-sources] ADD_SOURCE_FAILED", { name: e instanceof Error ? e.name : "unknown" })
    return { ok: false, error: partnerAdminErrorMessage(undefined) }
  }

  revalidatePath("/parametres")
  return {
    ok: true,
    message: `${domain} ajouté. Les e-mails reçus de ce domaine depuis 30 jours seront importés à la prochaine synchronisation (toutes les heures).`,
  }
}

export async function setConsultationSourceDomainActiveAction(input: {
  domainId: string
  active: boolean
}): Promise<SourceActionResult> {
  const admin = await requireSourcesAdmin()
  if (!admin) return { ok: false, error: "Accès refusé" }
  const domainId = String(input?.domainId ?? "")
  if (!domainId) return { ok: false, error: "Domaine introuvable." }

  try {
    if (input.active) {
      await acquisitionPartnerAdminService.activateDomain({ companyId: admin.companyId, domainId })
      await scheduleMailboxRescan(admin.companyId)
    } else {
      await acquisitionPartnerAdminService.deactivateDomain({ companyId: admin.companyId, domainId })
    }
  } catch (e) {
    if (isPartnerAdminError(e)) return { ok: false, error: partnerAdminErrorMessage(e.code) }
    return { ok: false, error: partnerAdminErrorMessage(undefined) }
  }
  revalidatePath("/parametres")
  return { ok: true, message: input.active ? "Domaine réactivé." : "Domaine désactivé : ses e-mails ne seront plus importés." }
}
