/**
 * LOT-2C — Router pur et empreinte de configuration (SPEC LOT-2 §10, §11, §12, §13, §20.1).
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { routeMessage, snapshotNeedsBody } from "@/lib/integration/router/tenant-router"
import {
  computeRoutingConfigurationVersion,
  type RoutingConfigSnapshot,
  type SnapshotRule,
} from "@/lib/integration/router/routing-config-snapshot"
import type { NormalizedMessage } from "@/lib/integration/contracts/normalized-message"
import { UnavailableLocalBodyPort } from "@/lib/integration/router/local-message-body.port"

const CO = "coA"
const NO_BODY = { available: false } as const

function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { externalMessageId: "ext1", contentCapabilities: [], sender: { email: "Contact@Maison-Martin.fr" }, ...over }
}
function rule(id: string, sourceId: string, type: SnapshotRule["type"], normalizedValue: string, enabled = true): SnapshotRule {
  return { id, sourceId, type, normalizedValue, enabled }
}
function snap(over: Partial<RoutingConfigSnapshot> = {}): RoutingConfigSnapshot {
  return {
    companyId: CO,
    sources: [{ id: "s1", enabled: true }],
    rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr")],
    bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: true, connectionId: null }],
    ...over,
  }
}
const route = (s: RoutingConfigSnapshot, m = msg(), connectionId = "cn1", body: Parameters<typeof routeMessage>[0]["body"] = NO_BODY) =>
  routeMessage({ connectionId, message: m, snapshot: s, body })

describe("Router — outcomes", () => {
  it("identité seule → MATCH vers consultations", () => {
    const r = route(snap())
    assert.deepEqual([r.outcome, r.matchedSourceIds, r.pipelineIds], ["MATCH", ["s1"], ["consultations"]])
  })
  it("domaine dérivé de l'email, casse et espaces ignorés ; sous-domaine non matché", () => {
    assert.equal(route(snap(), msg({ sender: { email: "  X@MAISON-MARTIN.FR " } })).outcome, "MATCH")
    assert.equal(route(snap(), msg({ sender: { email: "x@devis.maison-martin.fr" } })).outcome, "NO_MATCH")
    assert.equal(route(snap(), msg({ sender: { domain: "Maison-Martin.FR." } })).outcome, "MATCH")
  })
  it("SENDER_EMAIL exact", () => {
    const s = snap({ rules: [rule("r1", "s1", "SENDER_EMAIL", "contact@maison-martin.fr")] })
    assert.equal(route(s).outcome, "MATCH")
    assert.equal(route(s, msg({ sender: { email: "autre@maison-martin.fr" } })).outcome, "NO_MATCH")
  })
  it("identité + qualificatif : il faut au moins un qualificatif qui matche", () => {
    const s = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "SUBJECT_KEYWORD", "devis")] })
    assert.equal(route(s, msg({ subject: "Demande de DEVIS mariage" })).outcome, "MATCH")
    assert.equal(route(s, msg({ subject: "Facture" })).outcome, "NO_MATCH")
    assert.equal(route(s, msg({ subject: undefined })).outcome, "NO_MATCH", "subject absent : le qualificatif ne matche pas")
  })
  it("SUBJECT_KEYWORD normalisé NFC", () => {
    const s = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "SUBJECT_KEYWORD", "réception")] })
    assert.equal(route(s, msg({ subject: "RÉCEPTION du 12" })).outcome, "MATCH")
  })
  it("mot-clé seul sans identité : jamais de MATCH (pas d'admission keyword-only)", () => {
    const s = snap({ rules: [rule("r2", "s1", "SUBJECT_KEYWORD", "devis")] })
    assert.equal(route(s, msg({ subject: "devis" })).outcome, "NO_MATCH")
  })
  it("RECIPIENT_EMAIL : absent ⇒ ne matche pas", () => {
    const s = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "RECIPIENT_EMAIL", "devis@galya.fr")] })
    assert.equal(route(s, msg({ recipients: [{ email: "DEVIS@galya.fr" }] })).outcome, "MATCH")
    assert.equal(route(s, msg({ recipients: undefined })).outcome, "NO_MATCH")
  })
  it("BODY_KEYWORD : port indisponible ⇒ ne matche pas ; corps local ⇒ sous-chaîne", () => {
    const s = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "BODY_KEYWORD", "chapiteau")] })
    assert.equal(snapshotNeedsBody(s), true)
    assert.equal(route(s).outcome, "NO_MATCH")
    assert.equal(route(s, msg(), "cn1", { available: true, text: "Location d'un CHAPITEAU" }).outcome, "MATCH")
    assert.equal(snapshotNeedsBody(snap()), false)
  })
  it("port V1 toujours indisponible", async () => {
    assert.deepEqual(await new UnavailableLocalBodyPort().read(), { available: false })
  })
  it("plusieurs Sources valides → AMBIGUOUS_SOURCE, aucune attribution", () => {
    const s = snap({
      sources: [{ id: "s2", enabled: true }, { id: "s1", enabled: true }],
      rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r9", "s2", "SENDER_EMAIL", "contact@maison-martin.fr")],
    })
    const r = route(s)
    assert.deepEqual([r.outcome, r.matchedSourceIds, r.pipelineIds], ["AMBIGUOUS_SOURCE", ["s1", "s2"], []])
  })
  it("une candidate sans Binding actif → NO_ACTIVE_BINDING", () => {
    const r = route(snap({ bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: false, connectionId: null }] }))
    assert.deepEqual([r.outcome, r.matchedSourceIds, r.pipelineIds], ["NO_ACTIVE_BINDING", ["s1"], []])
  })
  it("scope Connection uniquement via le Binding", () => {
    const s = snap({ bindings: [{ id: "b1", sourceId: "s1", pipelineId: "consultations", enabled: true, connectionId: "cnX" }] })
    assert.equal(route(s, msg(), "cnX").outcome, "MATCH")
    assert.equal(route(s, msg(), "cnY").outcome, "NO_MATCH")
  })
  it("Source ou règle désactivée ignorée ; aucune Source → NO_MATCH (NO_ENABLED_SOURCE)", () => {
    assert.equal(route(snap({ sources: [{ id: "s1", enabled: false }] })).reasonCode, "NO_ENABLED_SOURCE")
    assert.equal(route(snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr", false)] })).outcome, "NO_MATCH")
  })
  it("champ absent : jamais ERROR", () => {
    const r = route(snap(), msg({ sender: undefined }))
    assert.equal(r.outcome, "NO_MATCH")
  })
})

describe("Router — diagnostics liés à la Source (revue du 24/11)", () => {
  it("subjectGap seulement pour une Source dont l'identité matche et qui exige un mot-clé d'objet", () => {
    const withKw = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "SUBJECT_KEYWORD", "devis")] })
    assert.deepEqual([route(withKw, msg({ subject: undefined })).diagnostics.subjectGap, route(withKw, msg({ subject: undefined })).diagnostics.qualifierGap], [true, true])
    const otherSource = snap({
      sources: [{ id: "s1", enabled: true }, { id: "s2", enabled: true }],
      rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r9", "s2", "SENDER_DOMAIN", "autre.fr"), rule("r8", "s2", "SUBJECT_KEYWORD", "devis")],
    })
    const r = route(otherSource, msg({ sender: { email: "x@inconnu.fr" }, subject: undefined }))
    assert.deepEqual([r.outcome, r.diagnostics.subjectGap, r.diagnostics.subjectKeywordRuleActive], ["NO_MATCH", false, true])
  })
})

describe("routingConfigurationVersion (I2)", () => {
  const base = snap({ rules: [rule("r1", "s1", "SENDER_DOMAIN", "maison-martin.fr"), rule("r2", "s1", "SUBJECT_KEYWORD", "devis")] })
  const v = computeRoutingConfigurationVersion(base)
  it("format rcv1_ + SHA-256 hex, stable sur N exécutions", () => {
    assert.match(v, /^rcv1_[0-9a-f]{64}$/)
    for (let i = 0; i < 20; i++) assert.equal(computeRoutingConfigurationVersion(base), v)
  })
  it("ordre d'entrée indifférent", () => {
    assert.equal(computeRoutingConfigurationVersion({ ...base, rules: [...base.rules].reverse() }), v)
  })
  it("éléments désactivés sans effet ; displayName et valeur brute hors empreinte", () => {
    const withDisabled = { ...base, rules: [...base.rules, rule("r3", "s1", "SENDER_EMAIL", "x@y.fr", false)] }
    assert.equal(computeRoutingConfigurationVersion(withDisabled), v)
    const withExtra = { ...base, sources: [{ id: "s1", enabled: true, displayName: "autre", value: "raw" } as never] }
    assert.equal(computeRoutingConfigurationVersion(withExtra), v)
  })
  it("tout changement fonctionnel change l'empreinte", () => {
    const variants: RoutingConfigSnapshot[] = [
      { ...base, rules: [rule("r1", "s1", "SENDER_DOMAIN", "autre.fr"), base.rules[1]!] },
      { ...base, rules: [base.rules[0]!] },
      { ...base, bindings: [{ ...base.bindings[0]!, connectionId: "cnX" }] },
      { ...base, bindings: [] },
      { ...base, sources: [...base.sources, { id: "s9", enabled: true }] },
    ]
    for (const x of variants) assert.notEqual(computeRoutingConfigurationVersion(x), v)
  })
  it("deux sociétés à configuration identique : empreintes distinctes", () => {
    assert.notEqual(computeRoutingConfigurationVersion({ ...base, companyId: "coB" }), v)
  })
})
