/**
 * Acceptation d'invitation — logique testable (hors fichier "use server").
 *
 * V1B-db : une identité archivée de la même entreprise est RÉACTIVÉE (mêmes User et Employee, IDs et historique
 * véhicule préservés) au lieu d'être supprimée puis recréée. Aucune fusion, aucune réactivation inter-entreprise.
 */

import { z } from "zod"
import {
  INVITE_ACCOUNT_AMBIGUOUS,
  INVITE_ACCOUNT_AMBIGUOUS_MESSAGE,
  isReactivableArchivedMember,
  type ExistingMember,
} from "@/lib/actions/invitation-invite.core"

export const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1, "Le nom est requis"),
  password: z.string().min(8, "8 caractères minimum"),
})

export type AcceptableInvitation = {
  id: string
  email: string
  role: "ADMIN" | "TEAM_LEADER" | "EMPLOYEE"
  companyId: string
}

export type AcceptInvitationDeps = {
  findInvitation: (token: string) => Promise<AcceptableInvitation | null>
  findUserByEmail: (email: string) => Promise<ExistingMember | null>
  hashPassword: (password: string) => Promise<string>
  /** Création du User (+ Employee si EMPLOYEE/TEAM_LEADER) et invitation ACCEPTED, en une transaction. */
  createMember: (args: { invitation: AcceptableInvitation; name: string; password: string }) => Promise<unknown>
  /**
   * Réactivation en une transaction, gardée par l'état attendu (User et Employee encore inactifs, même entreprise).
   * Renvoie false si l'état a changé entre-temps (rien n'est écrit).
   */
  reactivateMember: (args: {
    invitationId: string
    userId: string
    employeeId: string
    companyId: string
    role: AcceptableInvitation["role"]
    name: string
    password: string
  }) => Promise<boolean>
}

export async function acceptInvitationImpl(formData: FormData, deps: AcceptInvitationDeps) {
  const raw = {
    token: formData.get("token") as string,
    name: formData.get("name") as string,
    password: formData.get("password") as string,
  }

  const parsed = acceptSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const invitation = await deps.findInvitation(parsed.data.token)
  if (!invitation) return { error: "Invitation invalide ou expirée." }

  const existing = await deps.findUserByEmail(invitation.email)
  if (!existing) {
    const password = await deps.hashPassword(parsed.data.password)
    await deps.createMember({ invitation, name: parsed.data.name, password })
    return { success: true }
  }

  // Compte d'une autre entreprise (ou sans entreprise) : comportement historique, aucune réactivation.
  if (existing.companyId !== invitation.companyId) {
    return { error: "Un compte existe déjà avec cet email." }
  }
  if (!isReactivableArchivedMember(existing, invitation.companyId) || !existing.employeeProfile) {
    return { error: INVITE_ACCOUNT_AMBIGUOUS_MESSAGE, code: INVITE_ACCOUNT_AMBIGUOUS }
  }

  const password = await deps.hashPassword(parsed.data.password)
  const done = await deps.reactivateMember({
    invitationId: invitation.id,
    userId: existing.id,
    employeeId: existing.employeeProfile.id,
    companyId: invitation.companyId,
    role: invitation.role,
    name: parsed.data.name,
    password,
  })
  if (!done) return { error: INVITE_ACCOUNT_AMBIGUOUS_MESSAGE, code: INVITE_ACCOUNT_AMBIGUOUS }
  return { success: true }
}
