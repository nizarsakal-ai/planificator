/** Lot E Planificator V2 : règles pures des automatisations (validation, gabarits, clés d'événement, échéance). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { AUTOMATION_ERRORS, eventKeys, renderTemplate, taskDueDate, validateRule } from "@/lib/automation/automation.core"
import { STAGES } from "@/lib/crm/crm.core"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"

describe("règles", () => {
  it("tâche : intitulé obligatoire, échéance 0 à 365 jours ; notification : message obligatoire ; champs de l'autre action effacés", () => {
    const t = validateRule({ name: " Relancer ", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "CREATE_TASK", taskTitle: "Relancer {client}", taskDueInDays: 2, message: "ignoré" }, STAGES)
    assert.deepEqual(t, { ok: true, value: { name: "Relancer", trigger: "OPPORTUNITY_FOLLOW_UP_DUE", action: "CREATE_TASK", stageFilter: null, taskTitle: "Relancer {client}", taskAssigneeId: null, taskDueInDays: 2, message: null } })
    const n = validateRule({ name: "Alerte", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Devis {numero} accepté", taskTitle: "ignoré", taskDueInDays: 3 }, STAGES)
    assert.ok(n.ok)
    if (n.ok) assert.deepEqual([n.value.taskTitle, n.value.taskDueInDays, n.value.message], [null, null, "Devis {numero} accepté"])
    assert.deepEqual(validateRule({ name: "Règle", trigger: "QUOTE_ACCEPTED", action: "CREATE_TASK", taskTitle: "" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.taskTitle })
    assert.deepEqual(validateRule({ name: "Règle", trigger: "QUOTE_ACCEPTED", action: "CREATE_TASK", taskTitle: "Tâche", taskDueInDays: 366 }, STAGES), { ok: false, error: AUTOMATION_ERRORS.dueInDays })
    assert.deepEqual(validateRule({ name: "Règle", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.message })
  })
  it("liste fermée : déclencheur ou action inconnus refusés (aucun envoi de courriel possible) ; filtre d'étape limité", () => {
    assert.deepEqual(validateRule({ name: "Règle", trigger: "INVOICE_PAID", action: "NOTIFY_ADMINS", message: "Message" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.trigger })
    assert.deepEqual(validateRule({ name: "Règle", trigger: "QUOTE_ACCEPTED", action: "SEND_EMAIL", message: "Message" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.action })
    assert.deepEqual(validateRule({ name: "Règle", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Message", stageFilter: "WON" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.stageFilter })
    assert.deepEqual(validateRule({ name: "Règle", trigger: "OPPORTUNITY_STAGE_CHANGED", action: "NOTIFY_ADMINS", message: "Message", stageFilter: "SIGNED" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.stageFilter })
    assert.equal(validateRule({ name: "Règle", trigger: "OPPORTUNITY_STAGE_CHANGED", action: "NOTIFY_ADMINS", message: "Message", stageFilter: "WON" }, STAGES).ok, true)
    assert.deepEqual(validateRule({ name: "Rè", trigger: "QUOTE_ACCEPTED", action: "NOTIFY_ADMINS", message: "Message" }, STAGES), { ok: false, error: AUTOMATION_ERRORS.name })
  })
})

describe("gabarits, clés et échéances", () => {
  it("seuls les champs nommés sont remplacés, en texte brut ; valeur absente « — » ; longueur bornée", () => {
    assert.equal(renderTemplate("Relancer {client} ({numero}) {inconnu} {{titre}}", { client: "Durand\u0007", numero: "OPP-2026-0001", titre: "Façade" }, 200), "Relancer Durand  (OPP-2026-0001) {inconnu} {Façade}")
    assert.equal(renderTemplate("{chantier}", {}, 200), "—")
    assert.equal(renderTemplate("x".repeat(300), {}, 200).length, 200)
    assert.equal(renderTemplate("<script>{titre}</script>", { titre: "a" }, 200), "<script>a</script>", "texte brut : React l'échappe à l'affichage")
  })
  it("clés d'événement stables, distinctes par occurrence", () => {
    assert.equal(eventKeys.stageChanged("e1"), "ose:e1")
    assert.equal(eventKeys.followUpDue("o1", "2026-11-04"), "ofu:o1:2026-11-04")
    assert.notEqual(eventKeys.followUpDue("o1", "2026-11-04"), eventKeys.followUpDue("o1", "2026-11-11"))
    assert.equal(eventKeys.quoteAccepted("q1", new Date("2026-11-04T09:00:00Z")), "qa:q1:2026-11-04T09:00:00.000Z")
  })
  it("échéance : jour courant + N jours, midi UTC ; sans échéance ⇒ null", () => {
    assert.equal(taskDueDate(new Date("2026-11-04T00:00:00Z"), 2)?.toISOString(), "2026-11-06T12:00:00.000Z")
    assert.equal(taskDueDate(new Date("2026-11-04T00:00:00Z"), null), null)
  })
  it("drapeaux : \"true\" exact seulement", () => {
    for (const v of [undefined, "", "TRUE", "1"]) {
      assert.equal(isAutomationsEnabled({ AUTOMATIONS_ENABLED: v }), false)
      assert.equal(isCrmEnabled({ CRM_OPPORTUNITIES_ENABLED: v }), false)
    }
  })
})
