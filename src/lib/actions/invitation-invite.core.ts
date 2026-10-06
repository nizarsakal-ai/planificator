/**
 * Invitation membre — logique testable (hors fichier "use server").
 */

import { z } from "zod"
import crypto from "crypto"

export const inviteRoleSchema = z.enum(["ADMIN", "TEAM_LEADER", "EMPLOYEE"])

export const inviteSchema = z.object({
  email: z.string().email("Email invalide"),
  role: inviteRoleSchema,
})

/** Rôles invitables selon l’inviteur (source de vérité serveur). */
export function rolesAllowedForInviter(
  inviterRole: string
): ReadonlyArray<"ADMIN" | "TEAM_LEADER" | "EMPLOYEE"> {
  if (inviterRole === "ADMIN" || inviterRole === "SUPER_ADMIN") {
    return ["ADMIN", "TEAM_LEADER", "EMPLOYEE"]
  }
  // TEAM_LEADER : TEAM_LEADER / EMPLOYEE (UI historique) — jamais ADMIN
  if (inviterRole === "TEAM_LEADER") {
    return ["TEAM_LEADER", "EMPLOYEE"]
  }
  return []
}

export const INVITE_ACCOUNT_AMBIGUOUS = "INVITE_ACCOUNT_AMBIGUOUS"

export const INVITE_ACCOUNT_AMBIGUOUS_MESSAGE =
  "Ce compte existe déjà dans un état qui ne permet pas de le réinviter automatiquement. Contactez le support."

export type ExistingMember = {
  id: string
  active: boolean
  role: string
  companyId: string | null
  employeeProfile: { id: string; active: boolean; companyId: string } | null
}

/**
 * Identité archivée réactivable sans ambiguïté : même User et même Employee, tous deux de l'entreprise
 * d'invitation et tous deux désactivés (état produit par toggleEmployeActive), rôle EMPLOYEE ou TEAM_LEADER (jamais d'écrasement d'un ADMIN). Tout autre état est refusé.
 */
export function isReactivableArchivedMember(existing: ExistingMember, companyId: string): boolean {
  const p = existing.employeeProfile
  return (
    existing.companyId === companyId &&
    (existing.role === "EMPLOYEE" || existing.role === "TEAM_LEADER") &&
    !existing.active &&
    p !== null &&
    p.companyId === companyId &&
    !p.active
  )
}

export type InviterMembreDeps = {
  requireSession: () => Promise<{
    id: string
    role: string
    companyId: string | null
    name?: string | null
    email?: string | null
  }>
  findExistingUser: (
    email: string,
    companyId: string
  ) => Promise<ExistingMember | null>
  deletePendingInvitations: (email: string) => Promise<unknown>
  findCompanyName: (companyId: string) => Promise<string | null>
  createInvitation: (data: {
    email: string
    role: "ADMIN" | "TEAM_LEADER" | "EMPLOYEE"
    companyId: string
    invitedById: string
    token: string
    expiresAt: Date
  }) => Promise<unknown>
  sendEmail?: (args: {
    to: string
    token: string
    companyName: string
    invitedByName: string
    role: string
  }) => Promise<void>
  revalidate: () => void
  now?: () => Date
  randomToken?: () => string
}

export async function inviterMembreImpl(
  formData: FormData,
  deps: InviterMembreDeps
) {
  const user = await deps.requireSession()
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(user.role)) {
    throw new Error("Accès refusé")
  }
  if (!user.companyId) throw new Error("Entreprise introuvable")

  const raw = {
    email: formData.get("email") as string,
    role: formData.get("role") as string,
  }

  const parsed = inviteSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const allowed = rolesAllowedForInviter(user.role)
  if (!allowed.includes(parsed.data.role)) {
    return { error: "Accès refusé" }
  }

  const existing = await deps.findExistingUser(parsed.data.email, user.companyId)
  if (existing) {
    if (existing.employeeProfile?.active) {
      return { error: "Cet employé fait déjà partie de votre entreprise." }
    }
    // Jamais de suppression : une identité archivée est réactivée à l'acceptation (mêmes User/Employee,
    // historique véhicule préservé). Tout état incohérent est refusé sans réparation automatique.
    if (!isReactivableArchivedMember(existing, user.companyId)) {
      return { error: INVITE_ACCOUNT_AMBIGUOUS_MESSAGE, code: INVITE_ACCOUNT_AMBIGUOUS }
    }
  }

  await deps.deletePendingInvitations(parsed.data.email)

  const companyName = await deps.findCompanyName(user.companyId)
  const token =
    deps.randomToken?.() ?? crypto.randomBytes(32).toString("hex")
  const now = deps.now?.() ?? new Date()
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  await deps.createInvitation({
    email: parsed.data.email,
    role: parsed.data.role,
    companyId: user.companyId,
    invitedById: user.id,
    token,
    expiresAt: expires,
  })

  if (process.env.RESEND_API_KEY && deps.sendEmail) {
    try {
      await deps.sendEmail({
        to: parsed.data.email,
        token,
        companyName: companyName ?? "votre entreprise",
        invitedByName: user.name ?? user.email ?? "Admin",
        role: parsed.data.role,
      })
    } catch (e) {
      console.error("Erreur envoi email invitation:", e)
    }
  }

  const appUrl =
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  const invitationUrl = `${appUrl}/invitation?token=${token}`

  deps.revalidate()
  return { success: true, invitationUrl }
}
