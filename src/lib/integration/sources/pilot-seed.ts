/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2E
 * Amorçage du tenant pilote (plan I8) : traduit la configuration d'éligibilité legacy (partenaires d'acquisition,
 * leurs domaines et emails) en Sources, Rules et Bindings de routage.
 *
 * Traduction (une Source par partenaire actif du pipeline `consultations`) :
 * - `requireExactEmail = false` : un domaine actif → SENDER_DOMAIN ; un email actif → SENDER_EMAIL ;
 * - `requireExactEmail = true`  : emails actifs seulement (le domaine seul ne suffit pas en legacy) ;
 * - un Binding vers `consultations`, sans scope Connection (le legacy n'en a pas) ;
 * - Source, Binding activés seulement si au moins une règle d'identité est valide.
 * Partenaire écarté (code stable) : inactif, autre pipeline, aucune identité valide, ou Source déjà présente
 * (même nom) — l'amorçage est rejouable sans doublon.
 *
 * Le plan est pur (aucune I/O) ; l'application passe par `RoutingConfigAdminService` (AuthZ + audit sans valeur).
 * Les données legacy sont reçues par l'appelant (script) : cette couche n'importe jamais l'Acquisition.
 */
import { normalizeRuleValue, RuleValueNormalizationError } from "@/lib/integration/rules/normalize-rule-value"
import type { RoutingConfigActor, RoutingConfigAdminService } from "@/lib/integration/sources/routing-config-admin.service"

export interface LegacyPartnerInput {
  id: string
  name: string
  pipeline: string
  active: boolean
  requireExactEmail: boolean
  domains: { value: string; active: boolean }[]
  emails: { value: string; active: boolean }[]
}

export const PILOT_SEED_SKIP_CODES = {
  INACTIVE: "INACTIVE",
  PIPELINE_NOT_CONSULTATIONS: "PIPELINE_NOT_CONSULTATIONS",
  NO_VALID_IDENTITY: "NO_VALID_IDENTITY",
  ALREADY_SEEDED: "ALREADY_SEEDED",
} as const
export type PilotSeedSkipCode = (typeof PILOT_SEED_SKIP_CODES)[keyof typeof PILOT_SEED_SKIP_CODES]

export interface PlannedSource {
  partnerId: string
  displayName: string
  rules: { type: "SENDER_DOMAIN" | "SENDER_EMAIL"; value: string }[]
  /** Valeurs écartées car invalides après normalisation (comptées, jamais réécrites). */
  invalidValues: number
}

export interface PilotSeedPlan {
  sources: PlannedSource[]
  skipped: { partnerId: string; code: PilotSeedSkipCode }[]
}

function displayNameOf(name: string): string {
  return name.normalize("NFC").trim().slice(0, 200)
}

export function buildPilotSeedPlan(partners: LegacyPartnerInput[], existingDisplayNames: Iterable<string>): PilotSeedPlan {
  const existing = new Set([...existingDisplayNames].map((n) => displayNameOf(n).toLowerCase()))
  const plan: PilotSeedPlan = { sources: [], skipped: [] }
  for (const p of [...partners].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!p.active) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.INACTIVE }); continue }
    if (p.pipeline !== "consultations") { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.PIPELINE_NOT_CONSULTATIONS }); continue }
    const displayName = displayNameOf(p.name)
    if (existing.has(displayName.toLowerCase())) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.ALREADY_SEEDED }); continue }

    const candidates: { type: "SENDER_DOMAIN" | "SENDER_EMAIL"; raw: string }[] = [
      ...(p.requireExactEmail ? [] : p.domains.filter((d) => d.active).map((d) => ({ type: "SENDER_DOMAIN" as const, raw: d.value }))),
      ...p.emails.filter((e) => e.active).map((e) => ({ type: "SENDER_EMAIL" as const, raw: e.value })),
    ]
    const seen = new Set<string>()
    const rules: PlannedSource["rules"] = []
    let invalidValues = 0
    for (const c of candidates) {
      let normalized: string
      try { normalized = normalizeRuleValue(c.type, c.raw) } catch (e) {
        if (e instanceof RuleValueNormalizationError) { invalidValues++; continue }
        throw e
      }
      const key = `${c.type}|${normalized}`
      if (seen.has(key)) continue
      seen.add(key)
      rules.push({ type: c.type, value: normalized })
    }
    if (rules.length === 0) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.NO_VALID_IDENTITY }); continue }
    existing.add(displayName.toLowerCase())
    plan.sources.push({ partnerId: p.id, displayName, rules, invalidValues })
  }
  return plan
}

/** Résumé sans aucune valeur (domaines, emails) : utilisable dans un journal ou une sortie de script. */
export function summarizePilotSeedPlan(plan: PilotSeedPlan) {
  return {
    sourcesToCreate: plan.sources.length,
    rulesToCreate: plan.sources.reduce((n, s) => n + s.rules.length, 0),
    senderDomainRules: plan.sources.reduce((n, s) => n + s.rules.filter((r) => r.type === "SENDER_DOMAIN").length, 0),
    senderEmailRules: plan.sources.reduce((n, s) => n + s.rules.filter((r) => r.type === "SENDER_EMAIL").length, 0),
    invalidValuesIgnored: plan.sources.reduce((n, s) => n + s.invalidValues, 0),
    skipped: plan.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.code]: (acc[s.code] ?? 0) + 1 }), {}),
    sources: plan.sources.map((s) => ({ partnerId: s.partnerId, displayName: s.displayName, rules: s.rules.length })),
  }
}

export interface PilotSeedApplyResult {
  created: { partnerId: string; sourceId: string; rules: number; bindingId: string }[]
  failed: { partnerId: string; errorName: string }[]
}

/**
 * Applique le plan, partenaire par partenaire (un échec n'arrête pas les suivants ; une Source partiellement créée
 * reste DÉSACTIVÉE, donc sans effet sur le routage). Ordre : Source (désactivée) → règles → Binding → activation
 * du Binding → activation de la Source (l'invariant d'identité est alors satisfait).
 */
export async function applyPilotSeedPlan(
  plan: PilotSeedPlan,
  actor: RoutingConfigActor,
  admin: Pick<RoutingConfigAdminService, "createSource" | "createRule" | "createBinding" | "setBindingEnabled" | "setSourceEnabled">
): Promise<PilotSeedApplyResult> {
  const result: PilotSeedApplyResult = { created: [], failed: [] }
  for (const s of plan.sources) {
    try {
      const source = await admin.createSource(actor, s.displayName)
      for (const r of s.rules) await admin.createRule(actor, { sourceId: source.id, type: r.type, value: r.value })
      const binding = await admin.createBinding(actor, { sourceId: source.id })
      await admin.setBindingEnabled(actor, binding.id, true)
      await admin.setSourceEnabled(actor, source.id, true)
      result.created.push({ partnerId: s.partnerId, sourceId: source.id, rules: s.rules.length, bindingId: binding.id })
    } catch (error) {
      result.failed.push({ partnerId: s.partnerId, errorName: error instanceof Error ? error.name : "unknown" })
    }
  }
  return result
}
