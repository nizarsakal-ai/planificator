/**
 * Lot 2b juridique : suppression de son propre compte (Apple 5.1.1(v), Google Play, RGPD art. 17).
 *
 * Ce qui est supprimé : l'identité de connexion. L'e-mail et le nom sont effacés, le mot de passe est rendu
 * inutilisable et le compte est désactivé, ce qui coupe aussi les sessions ouvertes : le rappel `jwt` de `auth.ts`
 * refuse un compte inactif. Sont aussi supprimés : téléphone, photo de profil, notifications, demandes de
 * réinitialisation, accès à l'espace client.
 *
 * Ce qui est conservé : les données que l'employeur ou la société cliente doit garder par la loi (heures, paie,
 * notes de frais, factures). La fiche employé est désactivée mais pas effacée, pour les durées annoncées dans la
 * politique de confidentialité.
 *
 * Garde-fous :
 * - mot de passe ressaisi et mot « SUPPRIMER » tapé ;
 * - un super-administrateur ne peut pas se supprimer ;
 * - le dernier administrateur actif d'une société ne peut pas se supprimer : il doit nommer un autre
 *   administrateur ou demander la fermeture de l'espace de la société.
 */

export const DELETION_CONFIRMATION_WORD = "SUPPRIMER"

export type AccountDeletionResult =
  | { ok: true }
  | { ok: false; code: "UNAUTHENTICATED" | "INVALID_CONFIRMATION" | "BAD_PASSWORD" | "SUPER_ADMIN" | "LAST_ADMIN" | "ERROR"; error: string; companies?: string[] }

export interface AccountForDeletion {
  id: string
  role: string
  passwordHash: string
  /** Sociétés où ce compte est administrateur actif (rôle principal ou fiche employé). */
  adminCompanies: { id: string; name: string }[]
}

export interface AccountDeletionDeps {
  sessionUserId: () => Promise<string | null>
  findAccount: (userId: string) => Promise<AccountForDeletion | null>
  verifyPassword: (plain: string, hash: string) => Promise<boolean>
  /** Nombre d'autres administrateurs actifs de la société (hors ce compte). */
  countOtherAdmins: (args: { companyId: string; userId: string }) => Promise<number>
  /** Anonymisation et désactivation, tout ou rien (une transaction). */
  anonymize: (userId: string) => Promise<void>
}

export async function deleteOwnAccountImpl(
  input: { password: string; confirmation: string },
  deps: AccountDeletionDeps,
): Promise<AccountDeletionResult> {
  try {
    const userId = await deps.sessionUserId()
    if (!userId) return { ok: false, code: "UNAUTHENTICATED", error: "Vous n'êtes plus connecté." }

    if (input.confirmation.trim().toUpperCase() !== DELETION_CONFIRMATION_WORD) {
      return { ok: false, code: "INVALID_CONFIRMATION", error: `Tapez ${DELETION_CONFIRMATION_WORD} pour confirmer.` }
    }

    const account = await deps.findAccount(userId)
    if (!account) return { ok: false, code: "UNAUTHENTICATED", error: "Compte introuvable." }

    if (!input.password || !(await deps.verifyPassword(input.password, account.passwordHash))) {
      return { ok: false, code: "BAD_PASSWORD", error: "Mot de passe incorrect." }
    }

    if (account.role === "SUPER_ADMIN") {
      return { ok: false, code: "SUPER_ADMIN", error: "Un compte super-administrateur ne peut pas être supprimé depuis l'application." }
    }

    const blocking: string[] = []
    for (const company of account.adminCompanies) {
      if ((await deps.countOtherAdmins({ companyId: company.id, userId })) === 0) blocking.push(company.name)
    }
    if (blocking.length > 0) {
      return {
        ok: false,
        code: "LAST_ADMIN",
        companies: blocking,
        error: `Vous êtes le seul administrateur de : ${blocking.join(", ")}. Nommez d'abord un autre administrateur, ou demandez la fermeture de l'espace de la société depuis la page « Suppression de compte ».`,
      }
    }

    await deps.anonymize(userId)
    return { ok: true }
  } catch (error) {
    console.error("[account] suppression de compte en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, code: "ERROR", error: "La suppression a échoué. Réessayez ou contactez-nous." }
  }
}

/** Adresse de remplacement : unique, non routable (.invalid, RFC 2606), sans aucune donnée personnelle. */
export function anonymizedEmail(userId: string): string {
  return `compte-supprime-${userId}@supprime.invalid`
}
