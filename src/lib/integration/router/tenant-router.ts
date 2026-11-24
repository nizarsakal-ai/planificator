/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2C
 * Tenant Router PUR (SPEC LOT-2 §8, §10, §11, §12) : un `NormalizedMessage` + le snapshot de la même société
 * → un outcome métier. Aucune I/O, aucune persistance, aucun accès à l'Envelope, aucune admission (LOT-3).
 *
 * Par Source active :
 *  a. au moins une règle IDENTITÉ (SENDER_EMAIL / SENDER_DOMAIN) matche ;
 *  b. si la Source a au moins un qualificatif actif, au moins un qualificatif matche ;
 *  c. si son Binding actif porte un `connectionId`, il doit égaler celui du message (scope via Binding seulement).
 * Puis : 0 candidate → NO_MATCH ; >1 → AMBIGUOUS_SOURCE (aucune attribution) ;
 * 1 sans Binding actif → NO_ACTIVE_BINDING ; 1 avec Binding actif → MATCH (pipeline `consultations`).
 * Un champ absent fait seulement échouer les règles qui en dépendent (§10.3), jamais ERROR.
 */
import type { NormalizedMessage } from "@/lib/integration/contracts/normalized-message"
import { ROUTING_OUTCOMES, type RoutingOutcome } from "@/lib/integration/types/routing-outcome"
import {
  INBOUND_SOURCE_RULE_TYPES,
  isIdentityRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import type { LocalMessageBody } from "@/lib/integration/router/local-message-body.port"
import {
  buildRoutingConfigSnapshot,
  type RoutingConfigSnapshot,
  type SnapshotRule,
} from "@/lib/integration/router/routing-config-snapshot"

/** Codes machine stables (jamais de texte libre ni de valeur). */
export const ROUTING_REASON_CODES = {
  NO_ENABLED_SOURCE: "NO_ENABLED_SOURCE",
  NO_CANDIDATE: "NO_CANDIDATE",
  MULTIPLE_CANDIDATES: "MULTIPLE_CANDIDATES",
  CANDIDATE_WITHOUT_BINDING: "CANDIDATE_WITHOUT_BINDING",
  MATCHED: "MATCHED",
  INVALID_NORMALIZED_MESSAGE: "INVALID_NORMALIZED_MESSAGE",
  CONFIG_LIMIT_EXCEEDED: "CONFIG_LIMIT_EXCEEDED",
} as const
export type RoutingReasonCode = (typeof ROUTING_REASON_CODES)[keyof typeof ROUTING_REASON_CODES]

export interface RouterInput {
  connectionId: string
  message: NormalizedMessage
  snapshot: RoutingConfigSnapshot
  body: LocalMessageBody
}

export interface RouterResult {
  outcome: Exclude<RoutingOutcome, "DUPLICATE">
  matchedSourceIds: string[]
  pipelineIds: string[]
  reasonCode: RoutingReasonCode
  /** Nombre de règles évaluées (observabilité §16). */
  rulesEvaluated: number
  /** Diagnostics opaques pour les divergences expliquées de la parité (SPEC §14.6) — aucune valeur. */
  diagnostics: RouterDiagnostics
}

export interface RouterDiagnostics {
  /** Au moins une Source dont l'identité matche mais aucun qualificatif actif ne matche. */
  qualifierGap: boolean
  /** Une telle Source a un qualificatif SUBJECT_KEYWORD et le message n'a pas d'objet (écart lié à cette Source). */
  subjectGap: boolean
  /** Une telle Source a un qualificatif BODY_KEYWORD et le corps local est indisponible (écart lié à cette Source). */
  bodyGap: boolean
  subjectKeywordRuleActive: boolean
  bodyKeywordRuleActive: boolean
  subjectPresent: boolean
  bodyAvailable: boolean
}

function lower(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const t = v.trim().toLowerCase()
  return t.length > 0 ? t : undefined
}

function normalizeDomain(v: string | undefined): string | undefined {
  let d = lower(v)
  if (!d) return undefined
  if (d.startsWith("@")) d = d.slice(1)
  d = d.replace(/\.$/, "")
  return d.length > 0 ? d : undefined
}

/** Texte comparé aux mots-clés : trim, NFC, minuscules (§11.1). Vide ⇒ absent. */
export function normalizeKeywordHaystack(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const t = v.normalize("NFC").trim().toLowerCase()
  return t.length > 0 ? t : undefined
}

interface MessageFacts {
  senderEmail?: string
  senderDomain?: string
  recipientEmails: Set<string>
  subject?: string
  body?: string
}

function factsOf(message: NormalizedMessage, body: LocalMessageBody): MessageFacts {
  const senderEmail = lower(message.sender?.email)
  const derived = senderEmail && senderEmail.includes("@") ? senderEmail.slice(senderEmail.lastIndexOf("@") + 1) : undefined
  return {
    senderEmail,
    senderDomain: normalizeDomain(message.sender?.domain) ?? normalizeDomain(derived),
    recipientEmails: new Set(
      (message.recipients ?? []).map((r) => lower(r.email)).filter((e): e is string => Boolean(e))
    ),
    subject: normalizeKeywordHaystack(message.subject),
    body: body.available ? normalizeKeywordHaystack(body.text) : undefined,
  }
}

function ruleMatches(rule: SnapshotRule, f: MessageFacts): boolean {
  switch (rule.type) {
    case INBOUND_SOURCE_RULE_TYPES.SENDER_EMAIL:
      return f.senderEmail !== undefined && f.senderEmail === rule.normalizedValue
    case INBOUND_SOURCE_RULE_TYPES.SENDER_DOMAIN:
      return f.senderDomain !== undefined && f.senderDomain === rule.normalizedValue
    case INBOUND_SOURCE_RULE_TYPES.RECIPIENT_EMAIL:
      return f.recipientEmails.has(rule.normalizedValue)
    case INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD:
      return f.subject !== undefined && f.subject.includes(rule.normalizedValue)
    case INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD:
      return f.body !== undefined && f.body.includes(rule.normalizedValue)
    default: {
      const _exhaustive: never = rule.type
      return _exhaustive
    }
  }
}

/** Vrai si le snapshot contient au moins une règle BODY_KEYWORD active (le port n'est lu que dans ce cas). */
export function snapshotNeedsBody(snapshot: RoutingConfigSnapshot): boolean {
  return buildRoutingConfigSnapshot(snapshot).rules.some((r) => r.type === INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD)
}

export function routeMessage(input: RouterInput): RouterResult {
  const snap = buildRoutingConfigSnapshot(input.snapshot)
  const facts = factsOf(input.message, input.body)
  const diagnostics: RouterDiagnostics = {
    qualifierGap: false,
    subjectGap: false,
    bodyGap: false,
    subjectKeywordRuleActive: snap.rules.some((r) => r.type === INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD),
    bodyKeywordRuleActive: snap.rules.some((r) => r.type === INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD),
    subjectPresent: facts.subject !== undefined,
    bodyAvailable: facts.body !== undefined,
  }
  if (snap.sources.length === 0) {
    return { outcome: ROUTING_OUTCOMES.NO_MATCH, matchedSourceIds: [], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.NO_ENABLED_SOURCE, rulesEvaluated: 0, diagnostics }
  }
  let rulesEvaluated = 0
  const candidates: { sourceId: string; pipelineId: string | null }[] = []

  for (const source of snap.sources) {
    const rules = snap.rules.filter((r) => r.sourceId === source.id)
    const identities = rules.filter((r) => isIdentityRuleType(r.type))
    const qualifiers = rules.filter((r) => !isIdentityRuleType(r.type))
    // Binding actif : au plus un par Source (garanti en base) ; on prend le premier dans l'ordre canonique.
    const binding = snap.bindings.find((b) => b.sourceId === source.id) ?? null

    let identityOk = false
    for (const r of identities) {
      rulesEvaluated++
      if (ruleMatches(r, facts)) { identityOk = true; break }
    }
    if (!identityOk) continue

    let qualifierOk = qualifiers.length === 0
    for (const r of qualifiers) {
      rulesEvaluated++
      if (ruleMatches(r, facts)) { qualifierOk = true; break }
    }
    if (!qualifierOk) {
      diagnostics.qualifierGap = true
      if (!facts.subject && qualifiers.some((r) => r.type === INBOUND_SOURCE_RULE_TYPES.SUBJECT_KEYWORD)) diagnostics.subjectGap = true
      if (!facts.body && qualifiers.some((r) => r.type === INBOUND_SOURCE_RULE_TYPES.BODY_KEYWORD)) diagnostics.bodyGap = true
      continue
    }

    if (binding?.connectionId && binding.connectionId !== input.connectionId) continue
    candidates.push({ sourceId: source.id, pipelineId: binding ? binding.pipelineId : null })
  }

  if (candidates.length === 0) {
    return { outcome: ROUTING_OUTCOMES.NO_MATCH, matchedSourceIds: [], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.NO_CANDIDATE, rulesEvaluated, diagnostics }
  }
  if (candidates.length > 1) {
    return {
      outcome: ROUTING_OUTCOMES.AMBIGUOUS_SOURCE,
      matchedSourceIds: candidates.map((c) => c.sourceId),
      pipelineIds: [],
      reasonCode: ROUTING_REASON_CODES.MULTIPLE_CANDIDATES,
      rulesEvaluated,
      diagnostics,
    }
  }
  const only = candidates[0]!
  if (only.pipelineId === null) {
    return { outcome: ROUTING_OUTCOMES.NO_ACTIVE_BINDING, matchedSourceIds: [only.sourceId], pipelineIds: [], reasonCode: ROUTING_REASON_CODES.CANDIDATE_WITHOUT_BINDING, rulesEvaluated, diagnostics }
  }
  return { outcome: ROUTING_OUTCOMES.MATCH, matchedSourceIds: [only.sourceId], pipelineIds: [only.pipelineId], reasonCode: ROUTING_REASON_CODES.MATCHED, rulesEvaluated, diagnostics }
}
