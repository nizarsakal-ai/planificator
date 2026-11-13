"use server"
// Server Actions du compte bancaire de la société (SPEC-BANK-VERIF-001) : drapeau + garde comptable A2, zod strict, société de session.
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { requireAccountingAdmin } from "@/lib/accounting/access/accounting-access"
import { AccountingAccessError } from "@/lib/accounting/access/accounting-access.core"
import { isBankAccountVerificationEnabled } from "@/lib/invoice-import/invoice-import-feature-flag"
import { recordSandboxOutcome, saveBankAccount, startVerification, type BankContext } from "@/lib/bank-verification/bank-account.service"
import { PROVIDER_BLOCKED_MESSAGE, SANDBOX_OUTCOMES, resolveBankVerificationProvider } from "@/lib/bank-verification/provider"

type Result<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; error: string }
const RETURN_PATH = "/comptabilite/banque/verification/retour"

async function run<T>(fn: (ctx: BankContext) => Promise<Result<T>>): Promise<Result<T>> {
  if (!isBankAccountVerificationEnabled()) return { ok: false, error: "Fonctionnalité indisponible." }
  try {
    const c = await requireAccountingAdmin()
    return await fn({ companyId: c.companyId, userId: c.userId })
  } catch (error) {
    if (error instanceof AccountingAccessError) return { ok: false, error: "Accès refusé." }
    console.error("[banque] action compte bancaire en échec", error instanceof Error ? error.name : "erreur")
    return { ok: false, error: "Erreur serveur, réessayez." }
  }
}

const saveSchema = z.object({ iban: z.string().trim().min(5).max(50), holderName: z.string().trim().min(1).max(200), version: z.number().int().min(0).nullable() }).strict()
export async function saveBankAccountAction(raw: unknown): Promise<Result> {
  const p = saveSchema.safeParse(raw)
  if (!p.success) return { ok: false, error: "IBAN ou titulaire invalide." }
  return run(async (ctx) => {
    const r = await saveBankAccount(prisma, ctx, p.data)
    if (!r.ok) return r
    revalidatePath("/comptabilite/banque")
    return { ok: true }
  })
}

/** Lance la liaison : renvoie l'URL du parcours du prestataire. Sans prestataire compatible configuré : blocage explicite. */
export async function startBankVerificationAction(): Promise<Result<{ redirectUrl: string }>> {
  return run<{ redirectUrl: string }>(async (ctx) => {
    const resolved = resolveBankVerificationProvider()
    if (!resolved.ok) return { ok: false, error: PROVIDER_BLOCKED_MESSAGE[resolved.reason] }
    const base = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "")
    const r = await startVerification(prisma, ctx, resolved.provider, `${base}${RETURN_PATH}`)
    if (!r.ok) return r
    revalidatePath("/comptabilite/banque")
    return { ok: true, redirectUrl: r.value.redirectUrl }
  })
}

/** Simulateur d'essai uniquement (refusé si le prestataire actif n'est pas « sandbox », donc toujours refusé en production). */
export async function sandboxBankOutcomeAction(state: unknown, outcome: unknown): Promise<Result<{ returnUrl: string }>> {
  const s = z.string().min(10).max(200).safeParse(state), o = z.enum(SANDBOX_OUTCOMES).safeParse(outcome)
  if (!s.success || !o.success) return { ok: false, error: "Demande invalide." }
  return run<{ returnUrl: string }>(async (ctx) => {
    const resolved = resolveBankVerificationProvider()
    if (!resolved.ok || resolved.provider.name !== "sandbox") return { ok: false, error: "Simulateur indisponible." }
    if (!(await recordSandboxOutcome(prisma, ctx, s.data, o.data))) return { ok: false, error: "Session de vérification introuvable ou close." }
    return { ok: true, returnUrl: `${RETURN_PATH}?state=${encodeURIComponent(s.data)}` }
  })
}
