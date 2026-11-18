/**
 * Renvoi de l'e-mail d'accès à UN salarié (fiche employé) — logique testable hors fichier "use server".
 * Même e-mail et même lien que le renvoi groupé (définir / réinitialiser le mot de passe, valable 72 h) ;
 * le renvoi groupé de la liste des employés reste inchangé.
 */
export const ACCESS_LINK_TTL_MS = 72 * 60 * 60 * 1000

export type AccessTarget = {
  id: string
  firstName: string
  active: boolean
  role: string
  user: { id: string; email: string; active: boolean }
}

export type ResendAccessDeps = {
  /** Salarié de l'entreprise de la session uniquement (jamais d'une autre entreprise). */
  findEmployee: (employeeId: string, companyId: string) => Promise<AccessTarget | null>
  companyName: (companyId: string) => Promise<string | null>
  /** Remplace tout lien encore inutilisé par un nouveau (un seul lien valable à la fois). */
  replaceResetToken: (userId: string, token: string, expiresAt: Date) => Promise<void>
  sendWelcomeEmail: (args: { to: string; token: string; employeeName: string; companyName: string }) => Promise<unknown>
  newToken: () => string
  now: () => Date
  /**
   * Compte jamais activé (fiche RH complétée, invitation jamais acceptée) : invitation par le parcours existant,
   * qui réactive le compte et la fiche à l'acceptation (mot de passe choisi par le salarié).
   */
  sendInvitation: (email: string, role: "EMPLOYEE" | "TEAM_LEADER") => Promise<{ success?: boolean; error?: string }>
  /**
   * Fiche déjà réactivée mais compte resté inactif (fiche RH complétée puis « Réactiver ») : active le compte de cette
   * entreprise. Son mot de passe est un secret aléatoire jamais transmis : l'accès réel passe par le lien envoyé.
   * Renvoie faux si le compte n'est plus dans l'état attendu (rien n'est envoyé).
   */
  activateUser: (userId: string, companyId: string) => Promise<boolean>
}

export type ResendAccessResult =
  | { success: true; email: string; kind: "ACCESS_LINK" | "INVITATION" }
  | { success: false; error: string }

/** Adresse réservée d'une fiche créée depuis un document RH, sans boîte réelle (voir hr-documents/repository). */
export const isPlaceholderEmail = (email: string) => email.toLowerCase().endsWith(".invalid")

export async function resendAccessForEmployee(deps: ResendAccessDeps, companyId: string, employeeId: string): Promise<ResendAccessResult> {
  if (typeof employeeId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(employeeId)) return { success: false, error: "Employé introuvable." }
  const employee = await deps.findEmployee(employeeId, companyId)
  if (!employee) return { success: false, error: "Employé introuvable." }
  if (isPlaceholderEmail(employee.user.email))
    return { success: false, error: "Fiche à compléter : ajoutez d'abord l'adresse e-mail réelle du salarié." }
  // Compte jamais activé : un lien de mot de passe seul ne suffirait pas (connexion refusée, compte inactif).
  if (!employee.user.active && employee.active) {
    if (!await deps.activateUser(employee.user.id, companyId))
      return { success: false, error: "Le compte a changé entre-temps : actualisez la fiche puis réessayez." }
  } else if (!employee.user.active) {
    // Fiche et compte inactifs (fiche RH complétée, invitation jamais acceptée) : invitation, qui réactive les deux.
    if (employee.role !== "EMPLOYEE" && employee.role !== "TEAM_LEADER")
      return { success: false, error: "Compte non activé avec un rôle d'administration : activez-le depuis la supervision." }
    const invited = await deps.sendInvitation(employee.user.email, employee.role)
    return invited.success ? { success: true, email: employee.user.email, kind: "INVITATION" }
      : { success: false, error: invited.error ?? "L'invitation n'a pas pu être envoyée." }
  }
  if (!employee.active) return { success: false, error: "Salarié désactivé : réactivez-le avant de renvoyer son accès." }

  const token = deps.newToken()
  await deps.replaceResetToken(employee.user.id, token, new Date(deps.now().getTime() + ACCESS_LINK_TTL_MS))
  await deps.sendWelcomeEmail({
    to: employee.user.email,
    token,
    employeeName: employee.firstName,
    companyName: (await deps.companyName(companyId)) ?? "votre entreprise",
  })
  return { success: true, email: employee.user.email, kind: "ACCESS_LINK" }
}
