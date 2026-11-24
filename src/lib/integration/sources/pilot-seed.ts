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
 * Partenaire écarté (code stable) : inactif, autre pipeline, aucune identité valide, Source déjà complète (même nom),
 * ou second partenaire du même nom. L'amorçage est rejouable sans doublon ; une Source du même nom restée incomplète
 * (règle manquante, Binding absent ou désactivé, Source désactivée) est COMPLÉTÉE au rejeu (revue du 24/11, point 4).
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
  DUPLICATE_NAME: "DUPLICATE_NAME",
} as const
export type PilotSeedSkipCode = (typeof PILOT_SEED_SKIP_CODES)[keyof typeof PILOT_SEED_SKIP_CODES]

export interface PlannedSource {
  partnerId: string
  displayName: string
  rules: { type: "SENDER_DOMAIN" | "SENDER_EMAIL"; value: string }[]
  /** Valeurs écartées car invalides après normalisation (comptées, jamais réécrites). */
  invalidValues: number
}

/** État d'une Source existante du même nom (lu par l'appelant). */
export interface ExistingSourceState {
  id: string
  displayName: string
  enabled: boolean
  /** Règles actives, sous la forme `TYPE|normalizedValue`. */
  ruleKeys: string[]
  activeBindingId: string | null
  inactiveBindingIds: string[]
}

export interface PlannedCompletion {
  partnerId: string
  sourceId: string
  displayName: string
  missingRules: PlannedSource["rules"]
  /** Binding inactif à réactiver, ou null. */
  bindingToEnable: string | null
  createBinding: boolean
  enableSource: boolean
}

export interface PilotSeedPlan {
  sources: PlannedSource[]
  completions: PlannedCompletion[]
  skipped: { partnerId: string; code: PilotSeedSkipCode }[]
}

function displayNameOf(name: string): string {
  return name.normalize("NFC").trim().slice(0, 200)
}

/**
 * `existing` : Sources déjà présentes. Un simple nom vaut Source complète (compatibilité) ; un état détaillé permet
 * de compléter une Source restée inachevée.
 */
export function buildPilotSeedPlan(partners: LegacyPartnerInput[], existing: Iterable<string | ExistingSourceState>): PilotSeedPlan {
  const byName = new Map<string, ExistingSourceState | null>()
  for (const e of existing) {
    if (typeof e === "string") byName.set(displayNameOf(e).toLowerCase(), null)
    else byName.set(displayNameOf(e.displayName).toLowerCase(), e)
  }
  const taken = new Set<string>()
  const plan: PilotSeedPlan = { sources: [], completions: [], skipped: [] }
  for (const p of [...partners].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!p.active) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.INACTIVE }); continue }
    if (p.pipeline !== "consultations") { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.PIPELINE_NOT_CONSULTATIONS }); continue }
    const displayName = displayNameOf(p.name)
    const key = displayName.toLowerCase()
    if (taken.has(key)) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.DUPLICATE_NAME }); continue }

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
    taken.add(key)
    if (byName.has(key)) {
      const e = byName.get(key)
      if (!e) { plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.ALREADY_SEEDED }); continue }
      const have = new Set(e.ruleKeys)
      const missingRules = rules.filter((r) => !have.has(`${r.type}|${r.value}`))
      const bindingToEnable = e.activeBindingId ? null : (e.inactiveBindingIds[0] ?? null)
      const createBinding = !e.activeBindingId && e.inactiveBindingIds.length === 0
      const enableSource = !e.enabled
      if (missingRules.length === 0 && !bindingToEnable && !createBinding && !enableSource) {
        plan.skipped.push({ partnerId: p.id, code: PILOT_SEED_SKIP_CODES.ALREADY_SEEDED })
        continue
      }
      plan.completions.push({ partnerId: p.id, sourceId: e.id, displayName, missingRules, bindingToEnable, createBinding, enableSource })
      continue
    }
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
    sourcesToComplete: plan.completions.length,
    rulesToAddOnExisting: plan.completions.reduce((n, c) => n + c.missingRules.length, 0),
    skipped: plan.skipped.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.code]: (acc[s.code] ?? 0) + 1 }), {}),
    sources: plan.sources.map((s) => ({ partnerId: s.partnerId, displayName: s.displayName, rules: s.rules.length })),
  }
}

export interface PilotSeedApplyResult {
  created: { partnerId: string; sourceId: string; rules: number; bindingId: string }[]
  completed: { partnerId: string; sourceId: string; rulesAdded: number }[]
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
  const result: PilotSeedApplyResult = { created: [], completed: [], failed: [] }
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
  for (const c of plan.completions ?? []) {
    try {
      for (const r of c.missingRules) await admin.createRule(actor, { sourceId: c.sourceId, type: r.type, value: r.value })
      if (c.bindingToEnable) await admin.setBindingEnabled(actor, c.bindingToEnable, true)
      if (c.createBinding) {
        const binding = await admin.createBinding(actor, { sourceId: c.sourceId })
        await admin.setBindingEnabled(actor, binding.id, true)
      }
      if (c.enableSource) await admin.setSourceEnabled(actor, c.sourceId, true)
      result.completed.push({ partnerId: c.partnerId, sourceId: c.sourceId, rulesAdded: c.missingRules.length })
    } catch (error) {
      result.failed.push({ partnerId: c.partnerId, errorName: error instanceof Error ? error.name : "unknown" })
    }
  }
  return result
}
