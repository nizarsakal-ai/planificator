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
}

export type ResendAccessResult = { success: true; email: string } | { success: false; error: string }

/** Adresse réservée d'une fiche créée depuis un document RH, sans boîte réelle (voir hr-documents/repository). */
export const isPlaceholderEmail = (email: string) => email.toLowerCase().endsWith(".invalid")

export async function resendAccessForEmployee(deps: ResendAccessDeps, companyId: string, employeeId: string): Promise<ResendAccessResult> {
  if (typeof employeeId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(employeeId)) return { success: false, error: "Employé introuvable." }
  const employee = await deps.findEmployee(employeeId, companyId)
  if (!employee) return { success: false, error: "Employé introuvable." }
  if (isPlaceholderEmail(employee.user.email))
    return { success: false, error: "Fiche à compléter : ajoutez d'abord l'adresse e-mail réelle du salarié." }
  if (!employee.active) return { success: false, error: "Salarié désactivé : réactivez-le avant de renvoyer son accès." }
  if (!employee.user.active)
    return { success: false, error: "Compte pas encore activé (invitation non acceptée) : renvoyez-lui une invitation." }

  const token = deps.newToken()
  await deps.replaceResetToken(employee.user.id, token, new Date(deps.now().getTime() + ACCESS_LINK_TTL_MS))
  await deps.sendWelcomeEmail({
    to: employee.user.email,
    token,
    employeeName: employee.firstName,
    companyName: (await deps.companyName(companyId)) ?? "votre entreprise",
  })
  return { success: true, email: employee.user.email }
}
