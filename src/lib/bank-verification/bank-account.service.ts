// ═══════════════════════════════════════════════════════════════════════════
// SPEC-BANK-VERIF-001 — compte bancaire de la société et vérification par un prestataire (autorité métier).
// Contexte = garde comptable A2 (société de session) + drapeau BANK_ACCOUNT_VERIFICATION_ENABLED.
// Invariants : « VERIFIED » n'est écrit qu'ici, après `fetchResult` (serveur à serveur) confirmant le MÊME IBAN et un titulaire
// concordant ; tout changement d'IBAN remet le compte à « non vérifié » ; l'état de session est à usage unique et expire.
// Ce module n'écrit rien dans le rapprochement bancaire (bank_transactions, bank_statement_imports) ni dans billing_settings.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash, randomBytes } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { nameKey } from "@/lib/invoice-import/normalize"
import { isValidIban, maskIban, normalizeIban } from "./iban"
import { BankProviderError, type BankVerificationProvider, type VerificationOutcome } from "./provider"

type Db = PrismaClient
export interface BankContext { companyId: string; userId: string }
export const VERIFICATION_TTL_MS = 30 * 60 * 1000

export const BANK_ACCOUNT_ERRORS = {
  iban: "IBAN invalide : vérifiez la saisie (pays, longueur, clé de contrôle).",
  holder: "Titulaire du compte obligatoire.",
  stale: "Le compte a été modifié entretemps : rechargez la page.",
  noAccount: "Enregistrez d'abord l'IBAN de la société.",
  provider: "Le prestataire de vérification est indisponible. Réessayez plus tard.",
  session: "Lien de vérification invalide ou expiré : relancez la vérification.",
} as const

const hashState = (state: string): string => createHash("sha256").update(state).digest("hex")

export interface BankAccountView {
  id: string; ibanMasked: string; holderName: string; status: "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED"; provider: string | null
  verifiedAt: Date | null; verifiedHolderName: string | null; failureCode: string | null; version: number
  /** L'IBAN imprimé sur les factures (Paramètres de facturation) diffère du compte enregistré ici. */
  differsFromInvoiceIban: boolean
}

export async function getBankAccount(db: Db, ctx: BankContext): Promise<BankAccountView | null> {
  const [a, settings] = await Promise.all([
    db.companyBankAccount.findUnique({ where: { companyId: ctx.companyId } }),
    db.billingSettings.findUnique({ where: { companyId: ctx.companyId }, select: { iban: true } }),
  ])
  if (!a) return null
  const invoiceIban = settings?.iban ? normalizeIban(settings.iban) : ""
  return { id: a.id, ibanMasked: maskIban(a.iban), holderName: a.holderName, status: a.status, provider: a.provider, verifiedAt: a.verifiedAt, verifiedHolderName: a.verifiedHolderName, failureCode: a.failureCode, version: a.version, differsFromInvoiceIban: invoiceIban !== "" && invoiceIban !== a.iban }
}

/** Données de l'encart « Compte bancaire » : compte + raison sociale (titulaire proposé par défaut). */
export async function getBankAccountPanel(db: Db, ctx: BankContext): Promise<{ account: BankAccountView | null; companyName: string }> {
  const [account, company] = await Promise.all([getBankAccount(db, ctx), db.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } })])
  return { account, companyName: company?.name ?? "" }
}

/** Enregistre l'IBAN. IBAN modifié ⇒ compte « non vérifié » et sessions en cours expirées (la preuve portait sur l'ancien IBAN). */
export async function saveBankAccount(db: Db, ctx: BankContext, input: { iban: string; holderName: string; version: number | null }): Promise<LifecycleResult<{ changed: boolean }>> {
  const iban = normalizeIban(input.iban)
  const holderName = input.holderName.trim().slice(0, 200)
  if (!isValidIban(iban)) return { ok: false, error: BANK_ACCOUNT_ERRORS.iban }
  if (!holderName) return { ok: false, error: BANK_ACCOUNT_ERRORS.holder }
  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.companyBankAccount.findUnique({ where: { companyId: ctx.companyId } })
      if (!existing) {
        await tx.companyBankAccount.create({ data: { companyId: ctx.companyId, iban, holderName, createdById: ctx.userId } })
        await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "CompanyBankAccount", detail: `Compte bancaire enregistré (${maskIban(iban)})` } })
        return { ok: true as const, value: { changed: true } }
      }
      if (input.version === null || input.version !== existing.version) return { ok: false as const, error: BANK_ACCOUNT_ERRORS.stale }
      const ibanChanged = existing.iban !== iban
      if (!ibanChanged && existing.holderName === holderName) return { ok: true as const, value: { changed: false } }
      // Titulaire seul modifié sur un compte vérifié : la preuve (titulaire confirmé par le prestataire) reste attachée à l'IBAN.
      const reset = ibanChanged ? { status: "UNVERIFIED" as const, provider: null, verifiedAt: null, verifiedHolderName: null, failureCode: null } : {}
      const r = await tx.companyBankAccount.updateMany({ where: { id: existing.id, companyId: ctx.companyId, version: existing.version }, data: { iban, holderName, ...reset, updatedById: ctx.userId, version: { increment: 1 } } })
      if (r.count !== 1) return { ok: false as const, error: BANK_ACCOUNT_ERRORS.stale }
      if (ibanChanged) await tx.bankVerificationSession.updateMany({ where: { companyId: ctx.companyId, accountId: existing.id, status: "PENDING" }, data: { status: "EXPIRED", completedAt: new Date() } })
      await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "CompanyBankAccount", entityId: existing.id, detail: ibanChanged ? `IBAN modifié (${maskIban(iban)}) : vérification à refaire` : "Titulaire du compte bancaire modifié" } })
      return { ok: true as const, value: { changed: true } }
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: BANK_ACCOUNT_ERRORS.stale }
    throw e
  }
}

/** Ouvre un parcours de vérification chez le prestataire et renvoie l'URL de redirection. */
export async function startVerification(db: Db, ctx: BankContext, provider: BankVerificationProvider, returnUrl: string, now: Date = new Date()): Promise<LifecycleResult<{ redirectUrl: string }>> {
  const account = await db.companyBankAccount.findUnique({ where: { companyId: ctx.companyId } })
  if (!account) return { ok: false, error: BANK_ACCOUNT_ERRORS.noAccount }
  const state = randomBytes(32).toString("base64url")
  // Une seule session en cours par compte : les précédentes sont closes avant d'ouvrir la nouvelle (index unique partiel en filet).
  let sessionId: string
  try {
    sessionId = await db.$transaction(async (tx) => {
      await tx.bankVerificationSession.updateMany({ where: { companyId: ctx.companyId, accountId: account.id, status: "PENDING" }, data: { status: "EXPIRED", completedAt: now } })
      const s = await tx.bankVerificationSession.create({ data: { companyId: ctx.companyId, accountId: account.id, provider: provider.name, stateHash: hashState(state), iban: account.iban, expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS), createdById: ctx.userId }, select: { id: true } })
      return s.id
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Une vérification vient d'être lancée : rechargez la page." }
    throw e
  }
  // Appel réseau HORS transaction ; échec ⇒ session close, compte inchangé.
  let started: { redirectUrl: string; providerRef: string }
  try {
    started = await provider.start({ iban: account.iban, holderName: account.holderName, state, returnUrl })
  } catch (e) {
    await db.bankVerificationSession.updateMany({ where: { id: sessionId, companyId: ctx.companyId, status: "PENDING" }, data: { status: "FAILED", completedAt: new Date(), result: { code: "PROVIDER_START_FAILED" } } })
    if (e instanceof BankProviderError) return { ok: false, error: BANK_ACCOUNT_ERRORS.provider }
    throw e
  }
  await db.$transaction([
    db.bankVerificationSession.updateMany({ where: { id: sessionId, companyId: ctx.companyId }, data: { providerRef: started.providerRef.slice(0, 200), result: { holderName: account.holderName } } }),
    // Un compte déjà vérifié le reste tant qu'une nouvelle vérification n'a pas abouti ou échoué.
    db.companyBankAccount.updateMany({ where: { id: account.id, companyId: ctx.companyId, iban: account.iban, status: { in: ["UNVERIFIED", "FAILED"] } }, data: { status: "PENDING", failureCode: null, version: { increment: 1 } } }),
  ])
  return { ok: true, value: { redirectUrl: started.redirectUrl } }
}

export type CompletionStatus = "VERIFIED" | "FAILED" | "PENDING"
const FAILURE_LABEL: Record<string, string> = {
  REJECTED: "Le prestataire n'a pas confirmé le contrôle du compte.",
  IBAN_MISMATCH: "Le compte confirmé par le prestataire n'est pas l'IBAN enregistré.",
  HOLDER_MISMATCH: "Le titulaire confirmé par le prestataire ne correspond pas à la société.",
  IBAN_CHANGED: "L'IBAN a été modifié pendant la vérification.",
}
export const bankFailureLabel = (code: string | null): string => (code ? FAILURE_LABEL[code] ?? "La vérification a échoué." : "")

/** Le titulaire confirmé correspond-il à la société (raison sociale ou titulaire saisi) ? Comparaison sur clé normalisée, exacte. */
export function holderMatches(confirmed: string, expected: string[]): boolean {
  const c = nameKey(confirmed)
  return c !== "" && expected.some((e) => nameKey(e) === c)
}

/**
 * Retour du parcours : `state` identifie la session (usage unique, société de session, non expirée). Le résultat est LU chez le
 * prestataire ; rien de ce que contient l'URL de retour n'est cru. Rejeu ou état inconnu ⇒ refus sans effet.
 */
export async function completeVerification(db: Db, ctx: BankContext, provider: BankVerificationProvider, state: string, now: Date = new Date()): Promise<LifecycleResult<{ status: CompletionStatus }>> {
  if (!state || state.length > 200) return { ok: false, error: BANK_ACCOUNT_ERRORS.session }
  const session = await db.bankVerificationSession.findUnique({ where: { stateHash: hashState(state) } })
  if (!session || session.companyId !== ctx.companyId || session.status !== "PENDING" || session.provider !== provider.name) return { ok: false, error: BANK_ACCOUNT_ERRORS.session }
  if (session.expiresAt.getTime() <= now.getTime()) {
    await db.bankVerificationSession.updateMany({ where: { id: session.id, status: "PENDING" }, data: { status: "EXPIRED", completedAt: now } })
    await db.companyBankAccount.updateMany({ where: { id: session.accountId, companyId: ctx.companyId, status: "PENDING" }, data: { status: "UNVERIFIED", version: { increment: 1 } } })
    return { ok: false, error: BANK_ACCOUNT_ERRORS.session }
  }
  let outcome: VerificationOutcome
  try {
    outcome = await provider.fetchResult({ providerRef: session.providerRef, iban: session.iban, result: session.result })
  } catch (e) {
    if (e instanceof BankProviderError) return { ok: false, error: BANK_ACCOUNT_ERRORS.provider }
    throw e
  }
  if (outcome.status === "PENDING") return { ok: true, value: { status: "PENDING" } }

  return db.$transaction(async (tx) => {
    const [account, company] = await Promise.all([
      tx.companyBankAccount.findFirst({ where: { id: session.accountId, companyId: ctx.companyId } }),
      tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true } }),
    ])
    let failure: string | null = null
    if (outcome.status === "REJECTED") failure = "REJECTED"
    else if (!account || account.iban !== session.iban) failure = "IBAN_CHANGED"
    else if (normalizeIban(outcome.iban) !== session.iban) failure = "IBAN_MISMATCH"
    else if (!holderMatches(outcome.holderName, [company.name, account.holderName])) failure = "HOLDER_MISMATCH"

    // Clôture à usage unique : deux retours simultanés, un seul passe.
    const closed = await tx.bankVerificationSession.updateMany({ where: { id: session.id, status: "PENDING" }, data: { status: failure ? "FAILED" : "SUCCEEDED", completedAt: now, result: { code: failure ?? "CONFIRMED" } } })
    if (closed.count !== 1) return { ok: false as const, error: BANK_ACCOUNT_ERRORS.session }
    if (account && failure !== "IBAN_CHANGED") {
      await tx.companyBankAccount.updateMany({
        where: { id: account.id, companyId: ctx.companyId, iban: session.iban },
        data: failure
          ? { status: "FAILED", failureCode: failure, provider: null, verifiedAt: null, verifiedHolderName: null, version: { increment: 1 } }
          : { status: "VERIFIED", provider: provider.name, verifiedAt: now, verifiedHolderName: outcome.status === "CONFIRMED" ? outcome.holderName.slice(0, 200) : null, failureCode: null, version: { increment: 1 } },
      })
    }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "CompanyBankAccount", entityId: session.accountId, detail: failure ? `Vérification du compte bancaire échouée (${failure})` : `Compte bancaire vérifié par ${provider.name} (${maskIban(session.iban)})` } })
    return { ok: true as const, value: { status: failure ? ("FAILED" as const) : ("VERIFIED" as const) } }
  })
}

/** Simulateur uniquement : enregistre côté serveur l'issue choisie par le testeur (lue ensuite par `fetchResult`). */
export async function recordSandboxOutcome(db: Db, ctx: BankContext, state: string, outcome: string): Promise<boolean> {
  const session = await db.bankVerificationSession.findUnique({ where: { stateHash: hashState(state) } })
  if (!session || session.companyId !== ctx.companyId || session.status !== "PENDING" || session.provider !== "sandbox") return false
  const previous = (session.result as { holderName?: string } | null) ?? {}
  const r = await db.bankVerificationSession.updateMany({ where: { id: session.id, status: "PENDING", provider: "sandbox" }, data: { result: { ...previous, sandboxOutcome: outcome } } })
  return r.count === 1
}
