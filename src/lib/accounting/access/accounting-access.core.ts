/**
 * Garde d'accès du module Comptabilité — logique pure (dépendances injectées, aucun import Prisma/next-auth).
 *
 * Ordre réel des contrôles (le flag est lu AVANT la session, pour ne pas solliciter auth si le module est OFF) :
 *   flag serveur → session authentifiée → rôle → société active de la SESSION → société existante et active
 *   en base → accès comptable.
 * Multi-société (main, 65e314b) : le rôle et la société de session sont ceux de l'appartenance ACTIVE résolue
 * par `resolveCompanyAccess` dans le callback JWT ; la garde comptable s'appuie sur cette autorité.
 *
 * Règles de sécurité (Lot 0) :
 * - AUCUNE entrée client n'est acceptée : ni `companyId`, ni formulaire, ni paramètre d'URL.
 *   Les fonctions de ce module ne prennent que des dépendances serveur ; un argument supplémentaire est ignoré.
 * - ADMIN : uniquement la société active de sa session (appartenance ADMIN active résolue par le callback JWT),
 *   obligatoire, existante et active.
 * - SUPER_ADMIN : REFUSÉ dans le Lot 0, même s'il possède exceptionnellement un companyId. Aucun repli vers une
 *   société rattachée au compte, aucun sélecteur de société : le mécanisme de contexte société explicite pour
 *   SUPER_ADMIN n'existe pas encore et sera conçu dans un lot ultérieur.
 * - TEAM_LEADER, EMPLOYEE, CLIENT et tout rôle inconnu : refusés.
 * - Tout échec (flag, session, rôle, société, erreur d'accès base) ⇒ refus (fail-closed).
 */

export const ACCOUNTING_ALLOWED_ROLES = ["ADMIN"] as const
export type AccountingAllowedRole = (typeof ACCOUNTING_ALLOWED_ROLES)[number]

export type AccountingAccessDenial =
  | "MODULE_DISABLED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NO_COMPANY"
  | "COMPANY_UNAVAILABLE"

export interface AccountingSessionLike {
  user?: { id?: string | null; role?: string | null; companyId?: string | null } | null
}

export interface AccountingCompanyRecord {
  id: string
  active: boolean
}

export interface AccountingAccessDeps {
  auth: () => Promise<AccountingSessionLike | null>
  isModuleEnabled: () => boolean
  findCompany: (companyId: string) => Promise<AccountingCompanyRecord | null>
}

export interface AccountingAccessContext {
  userId: string
  role: AccountingAllowedRole
  /** Toujours issu de la session serveur, jamais d'une entrée client. */
  companyId: string
}

export type AccountingAccessResult =
  | { ok: true; context: AccountingAccessContext }
  | { ok: false; reason: AccountingAccessDenial }

export class AccountingAccessError extends Error {
  constructor(readonly reason: AccountingAccessDenial) {
    super(`ACCOUNTING_ACCESS_DENIED:${reason}`)
    this.name = "AccountingAccessError"
  }
}

function isAllowedRole(role: unknown): role is AccountingAllowedRole {
  return typeof role === "string" && (ACCOUNTING_ALLOWED_ROLES as readonly string[]).includes(role)
}

/** Société de la session, normalisée ; chaîne vide si absente. */
function sessionCompanyId(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export async function resolveAccountingAccess(deps: AccountingAccessDeps): Promise<AccountingAccessResult> {
  // 1. Flag serveur : OFF ⇒ le module n'existe pas, sans même solliciter la session.
  if (deps.isModuleEnabled() !== true) return { ok: false, reason: "MODULE_DISABLED" }

  // 2. Session authentifiée côté serveur.
  let session: AccountingSessionLike | null
  try {
    session = await deps.auth()
  } catch {
    return { ok: false, reason: "UNAUTHENTICATED" }
  }
  const user = session?.user
  const userId = typeof user?.id === "string" ? user.id.trim() : ""
  if (!user || !userId) return { ok: false, reason: "UNAUTHENTICATED" }

  // 3. Rôle : ADMIN uniquement (SUPER_ADMIN refusé dans le Lot 0, même avec un companyId).
  if (!isAllowedRole(user.role)) return { ok: false, reason: "FORBIDDEN" }

  // 4. Contexte société : issu de la session, obligatoire.
  const companyId = sessionCompanyId(user.companyId)
  if (!companyId) return { ok: false, reason: "NO_COMPANY" }

  // 5. Validation serveur de la société (existante et active). Erreur d'accès ⇒ refus.
  let company: AccountingCompanyRecord | null
  try {
    company = await deps.findCompany(companyId)
  } catch {
    return { ok: false, reason: "COMPANY_UNAVAILABLE" }
  }
  if (!company || company.id !== companyId || company.active !== true) {
    return { ok: false, reason: "COMPANY_UNAVAILABLE" }
  }

  return { ok: true, context: { userId, role: user.role, companyId } }
}

/** Variante pour Server Actions / routes : lève `AccountingAccessError` si l'accès est refusé. */
export async function requireAccountingAdminImpl(deps: AccountingAccessDeps): Promise<AccountingAccessContext> {
  const result = await resolveAccountingAccess(deps)
  if (!result.ok) throw new AccountingAccessError(result.reason)
  return result.context
}

export type AccountingDenialDisposition = "login" | "not-found" | "dashboard"

/**
 * Réaction d'une PAGE à un refus (conventions existantes : /login si non connecté, /dashboard si rôle ou
 * société inadéquats ; module désactivé ⇒ 404, aucune indication que le module existe).
 */
export function accountingDenialDisposition(reason: AccountingAccessDenial): AccountingDenialDisposition {
  switch (reason) {
    case "UNAUTHENTICATED":
      return "login"
    case "MODULE_DISABLED":
      return "not-found"
    default:
      return "dashboard"
  }
}

/**
 * Visibilité du lien « Comptabilité » (affichage uniquement, JAMAIS une autorisation) :
 * flag serveur actif, rôle ADMIN (jamais SUPER_ADMIN dans le Lot 0), société présente.
 * L'autorisation réelle est `resolveAccountingAccess`.
 */
export function isAccountingNavVisible(input: {
  enabled: boolean
  role: string | null | undefined
  companyId: string | null | undefined
}): boolean {
  return input.enabled === true && isAllowedRole(input.role) && sessionCompanyId(input.companyId) !== ""
}
