"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import { isProspectionNavVisible, isProspectionWatchEnabled } from "@/lib/prospection/prospection-feature-flag"
import { updateOpportunityStatus } from "@/lib/prospection/prospection.repository"
import { PROSPECT_STATUSES } from "@/lib/prospection/prospection.types"

const inputSchema = z.object({
  id: z.string().min(1).max(64),
  status: z.enum(PROSPECT_STATUSES),
})

export type UpdateOpportunityStatusResult = { ok: true } | { ok: false; error: string }

/** Seule écriture de l'interface : le suivi humain d'une opportunité. Aucun envoi n'est déclenché. */
export async function updateOpportunityStatusAction(id: string, status: string): Promise<UpdateOpportunityStatusResult> {
  const session = await auth()
  const user = session?.user
  if (!user || !isProspectionNavVisible({ enabled: isProspectionWatchEnabled(), role: user.role, companyId: user.companyId })) {
    return { ok: false, error: "Accès refusé" }
  }
  const parsed = inputSchema.safeParse({ id, status })
  if (!parsed.success) return { ok: false, error: "Statut invalide" }

  const updated = await updateOpportunityStatus({
    companyId: user.companyId as string,
    id: parsed.data.id,
    status: parsed.data.status,
    userId: user.id,
    now: new Date(),
  })
  if (!updated) return { ok: false, error: "Opportunité introuvable" }
  revalidatePath("/opportunites")
  return { ok: true }
}
