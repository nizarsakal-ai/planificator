// Bouton « Valider » de la liste fournisseurs — contrôleur pur (29/10/2026) : succès sans navigation, erreur explicite, double clic ignoré.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { QUICK_VALIDATE_SERVER_ERROR, createQuickValidator, type QuickValidateResult } from "@/components/comptabilite/quick-validate"

function harness(validate: () => Promise<QuickValidateResult>) {
  const log = { calls: 0, refresh: 0, success: 0, errors: [] as string[], busy: [] as boolean[] }
  const v = createQuickValidator({
    validate: () => { log.calls++; return validate() },
    refresh: () => { log.refresh++ },
    onBusyChange: (b) => { log.busy.push(b) },
    onSuccess: () => { log.success++ },
    onError: (m) => { log.errors.push(m) },
  })
  return { v, log }
}
const deferred = () => { let resolve!: (r: QuickValidateResult) => void; const p = new Promise<QuickValidateResult>((r) => { resolve = r }); return { p, resolve } }

describe("createQuickValidator", () => {
  it("succès : un appel serveur, rafraîchissement sur place (seule voie de mise à jour : aucune navigation possible), état occupé puis libre", async () => {
    const { v, log } = harness(async () => ({ ok: true }))
    assert.equal(await v.trigger(), "succeeded")
    assert.deepEqual([log.calls, log.success, log.refresh, log.errors.length], [1, 1, 1, 0])
    assert.deepEqual(log.busy, [true, false]); assert.equal(v.busy, false)
  })
  it("erreur métier (ex. restauration sans compte confirmé) : message serveur affiché tel quel, AUCUN rafraîchissement", async () => {
    const msg = "Restauration : choisissez et confirmez un compte de charge avant de comptabiliser."
    const { v, log } = harness(async () => ({ ok: false, error: msg }))
    assert.equal(await v.trigger(), "failed")
    assert.deepEqual(log.errors, [msg]); assert.deepEqual([log.refresh, log.success], [0, 0]); assert.deepEqual(log.busy, [true, false])
  })
  it("exception (réseau, serveur) : message générique explicite, bouton libéré", async () => {
    const { v, log } = harness(async () => { throw new Error("network") })
    assert.equal(await v.trigger(), "failed")
    assert.deepEqual(log.errors, [QUICK_VALIDATE_SERVER_ERROR]); assert.equal(v.busy, false)
  })
  it("double clic : le second clic pendant l'appel en vol est ignoré — un seul appel serveur, un seul rafraîchissement", async () => {
    const d = deferred()
    const { v, log } = harness(() => d.p)
    const first = v.trigger()
    assert.equal(v.busy, true)
    assert.equal(await v.trigger(), "ignored")
    assert.equal(await v.trigger(), "ignored")
    d.resolve({ ok: true })
    assert.equal(await first, "succeeded")
    assert.deepEqual([log.calls, log.refresh], [1, 1])
  })
  it("après un échec, un nouveau clic relance bien l'action (réessai explicite possible)", async () => {
    let n = 0
    const { v, log } = harness(async () => (++n === 1 ? { ok: false, error: "Erreur serveur, réessayez." } : { ok: true }))
    assert.equal(await v.trigger(), "failed")
    assert.equal(await v.trigger(), "succeeded")
    assert.deepEqual([log.calls, log.refresh], [2, 1])
  })
})
