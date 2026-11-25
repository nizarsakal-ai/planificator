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
 *   administrateur ou demander la fermeture de l'espace de la société. Le contrôle est refait dans la transaction,
 *   sous verrou des sociétés, contre les suppressions simultanées.
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

export type AnonymizeOutcome =
  | { ok: true; avatarUrls: string[] }
  /** Recompte sous verrou : une suppression concurrente a laissé une société sans autre administrateur. Rien n'est écrit. */
  | { ok: false; lastAdminCompanies: string[] }

export interface AccountDeletionDeps {
  sessionUserId: () => Promise<string | null>
  findAccount: (userId: string) => Promise<AccountForDeletion | null>
  verifyPassword: (plain: string, hash: string) => Promise<boolean>
  /** Nombre d'autres administrateurs actifs de la société (hors ce compte). Pré-contrôle rapide, hors transaction. */
  countOtherAdmins: (args: { companyId: string; userId: string }) => Promise<number>
  /**
   * Anonymisation et désactivation, tout ou rien (une transaction). Reprend le contrôle « dernier administrateur »
   * sous verrou des sociétés concernées : deux suppressions simultanées ne peuvent pas laisser une société sans admin.
   */
  anonymize: (userId: string, adminCompanies: { id: string; name: string }[]) => Promise<AnonymizeOutcome>
  /** Suppression des photos de profil chez l'hébergeur de fichiers, après validation de la transaction. */
  deleteAvatars: (urls: string[]) => Promise<void>
}

function lastAdminRefusal(companies: string[]): AccountDeletionResult {
  return {
    ok: false,
    code: "LAST_ADMIN",
    companies,
    error: `Vous êtes le seul administrateur de : ${companies.join(", ")}. Nommez d'abord un autre administrateur, ou demandez la fermeture de l'espace de la société depuis la page « Suppression de compte ».`,
  }
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
    if (blocking.length > 0) return lastAdminRefusal(blocking)

    const outcome = await deps.anonymize(userId, account.adminCompanies)
    if (!outcome.ok) return lastAdminRefusal(outcome.lastAdminCompanies)
    if (outcome.avatarUrls.length > 0) {
      try {
        await deps.deleteAvatars(outcome.avatarUrls)
      } catch (error) {
        // Le compte est supprimé ; la photo orpheline est signalée dans les journaux pour un effacement manuel.
        console.error("[account] photo de profil non effacée chez l'hébergeur", error instanceof Error ? error.name : "erreur")
      }
    }
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

/**
 * Identifiant Cloudinary d'une image à partir de son adresse de livraison
 * (https://res.cloudinary.com/<cloud>/image/upload/[transformations/][v123/]<public_id>.<ext>). Null si l'adresse n'est
 * pas une image Cloudinary reconnue : on n'efface jamais au hasard.
 */
export function cloudinaryPublicIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.hostname !== "res.cloudinary.com") return null
  const m = parsed.pathname.match(/^\/[^/]+\/image\/upload\/(.+)$/)
  if (!m) return null
  const parts = m[1].split("/")
  const v = parts.findIndex((p) => /^v\d+$/.test(p))
  const rest = (v >= 0 ? parts.slice(v + 1) : parts).join("/")
  const id = decodeURIComponent(rest.replace(/\.[a-z0-9]+$/i, ""))
  return id || null
}
