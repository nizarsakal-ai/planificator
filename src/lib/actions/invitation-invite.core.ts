/**
 * Invitation membre — logique testable (hors fichier "use server").
 */

import { z } from "zod"
import crypto from "crypto"

export const inviteRoleSchema = z.enum(["ADMIN", "TEAM_LEADER", "EMPLOYEE"])

// E-mail normalisé côté serveur (espaces, casse) : une invitation est toujours émise en minuscules,
// comme l'identité de connexion (credentialsSchema) et les créations de compte.
export const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
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

/** Plusieurs identités (ou une identité d'une autre casse) correspondent à l'adresse : aucune n'est choisie. */
export const INVITE_IDENTITY_AMBIGUOUS = "INVITE_IDENTITY_AMBIGUOUS"
export const INVITE_IDENTITY_AMBIGUOUS_MESSAGE =
  "Plusieurs comptes correspondent à cette adresse (casse différente). Contactez le support."
/** Valeur renvoyée par le port d'identité quand la correspondance n'est pas unique. */
export const IDENTITY_AMBIGUOUS = "AMBIGUOUS" as const

export const INVITE_TARGET_INVALID_MESSAGE = "Entreprise cible invalide."
export const INVITE_TARGET_UNAVAILABLE_MESSAGE = "Entreprise cible introuvable ou désactivée."
/** Identifiant d'entreprise tel que généré par Prisma (cuid) ; aucune autre forme n'est acceptée. */
const TARGET_COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/

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

export type InvitationRole = "ADMIN" | "TEAM_LEADER" | "EMPLOYEE"

export type InviterMembreDeps = {
  requireSession: () => Promise<{
    id: string
    role: string
    companyId: string | null
    name?: string | null
    email?: string | null
  }>
  /**
   * Identité correspondant à l'adresse (recherche insensible à la casse côté adaptateur) :
   * `null` si aucune (ou une identité d'une autre entreprise, rattachée à l'acceptation),
   * `IDENTITY_AMBIGUOUS` si la correspondance n'est pas unique — aucune sélection arbitraire.
   */
  findExistingUser: (
    email: string,
    companyId: string
  ) => Promise<ExistingMember | null | typeof IDENTITY_AMBIGUOUS>
  deletePendingInvitations: (email: string, companyId: string) => Promise<unknown>
  findCompanyName: (companyId: string) => Promise<string | null>
  createInvitation: (data: {
    email: string
    role: InvitationRole
    companyId: string
    invitedById: string
    token: string
    expiresAt: Date
  }) => Promise<unknown>
  /**
   * Supervision (SUPER_ADMIN, champ `targetCompanyId`) : entreprise cible désignée par son id, jamais par son nom.
   * Les deux ports sont obligatoires pour ce parcours ; l'absence de l'un ⇒ refus avant toute lecture ou écriture.
   */
  findTargetCompany?: (companyId: string) => Promise<{ id: string; name: string; active: boolean } | null>
  /**
   * Transaction unique : purge des invitations PENDING (adresse, cible) + création + journal INVITED.
   * Toute erreur ⇒ rien n'est écrit (rollback) et l'erreur est propagée : ni lien, ni e-mail, ni revalidation.
   */
  createSupervisedInvitation?: (data: {
    email: string
    role: InvitationRole
    companyId: string
    invitedById: string
    token: string
    expiresAt: Date
  }) => Promise<{ id: string }>
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

  // Entreprise d'émission.
  // - Sans champ `targetCompanyId` : parcours historique, entreprise de la session (inchangé).
  // - Champ présent : parcours de supervision, réservé au SUPER_ADMIN ; la valeur doit être un id bien formé
  //   (vide ou mal typé ⇒ refus, jamais de repli silencieux), l'entreprise doit exister et être active,
  //   et l'émission est journalisée — même si la cible est l'entreprise courante du SUPER_ADMIN.
  const rawTarget = formData.get("targetCompanyId")
  const supervised = rawTarget !== null
  let companyId: string
  let targetName: string | null = null
  if (supervised) {
    if (user.role !== "SUPER_ADMIN") return { error: "Accès refusé" }
    if (typeof rawTarget !== "string" || !TARGET_COMPANY_ID.test(rawTarget)) return { error: INVITE_TARGET_INVALID_MESSAGE }
    if (!deps.findTargetCompany || !deps.createSupervisedInvitation) return { error: "Accès refusé" }
    const target = await deps.findTargetCompany(rawTarget)
    if (!target || !target.active) return { error: INVITE_TARGET_UNAVAILABLE_MESSAGE }
    companyId = target.id
    targetName = target.name
  } else {
    if (!user.companyId) throw new Error("Entreprise introuvable")
    companyId = user.companyId
  }

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

  const existing = await deps.findExistingUser(parsed.data.email, companyId)
  if (existing === IDENTITY_AMBIGUOUS) {
    return { error: INVITE_IDENTITY_AMBIGUOUS_MESSAGE, code: INVITE_IDENTITY_AMBIGUOUS }
  }
  if (existing) {
    if (existing.employeeProfile?.active) {
      return { error: "Cet employé fait déjà partie de votre entreprise." }
    }
    // Jamais de suppression : une identité archivée est réactivée à l'acceptation (mêmes User/Employee,
    // historique véhicule préservé). Tout état incohérent est refusé sans réparation automatique.
    if (!isReactivableArchivedMember(existing, companyId)) {
      return { error: INVITE_ACCOUNT_AMBIGUOUS_MESSAGE, code: INVITE_ACCOUNT_AMBIGUOUS }
    }
  }

  const token =
    deps.randomToken?.() ?? crypto.randomBytes(32).toString("hex")
  const now = deps.now?.() ?? new Date()
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const invitation = {
    email: parsed.data.email,
    role: parsed.data.role,
    companyId,
    invitedById: user.id,
    token,
    expiresAt: expires,
  }

  let companyName: string | null
  if (supervised) {
    // Purge + création + journal en une seule transaction ; en cas d'échec rien n'est écrit et l'erreur
    // remonte avant tout effet externe (lien, e-mail, revalidation).
    await deps.createSupervisedInvitation!(invitation)
    companyName = targetName
  } else {
    await deps.deletePendingInvitations(parsed.data.email, companyId)
    companyName = await deps.findCompanyName(companyId)
    await deps.createInvitation(invitation)
  }

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
