/**
 * Destinataires des photos — preuves sur PostgreSQL RÉEL et JETABLE (données entièrement fictives) :
 * migration (rollback non destructif à vide puis ré-application, contraintes, borne de 20, unicité insensible à la casse),
 * cœur transactionnel via Prisma : marqueur « configurée » (y compris liste vide), différence stable (identifiants conservés),
 * réorganisation et remplacement complet sans conflit, désactivation conservée, vider → recharger → réenregistrer sans
 * réactiver l'adresse historique, autorité SUPER_ADMIN relue, isolation d'entreprise, atomicité, audit sans adresse.
 * `clientContact` n'est jamais modifié.
 *
 * Prérequis : WORKSITE_PHOTOS_TEST_DATABASE_URL = base jetable locale migrée, jamais DATABASE_URL.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { updateWorksiteWithPhotoRecipients } from "@/lib/actions/chantier-photo-recipients.core"
import { initialRecipientState, type PhotoRecipientInput } from "@/lib/chantiers/photo-recipients"

const require = createRequire(import.meta.url)
const MIGRATION = "20261031150000_worksite_photo_recipients"

function disposableUrl(): string {
  const url = process.env.WORKSITE_PHOTOS_TEST_DATABASE_URL?.trim()
  if (!url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL absente : base PostgreSQL jetable requise.")
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname)) throw new Error("base locale jetable exigée")
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === url) throw new Error("WORKSITE_PHOTOS_TEST_DATABASE_URL ne doit pas être DATABASE_URL.")
  return url
}
function prismaCli(url: string, args: string[]) {
  return spawnSync(process.execPath, [require.resolve("prisma/build/index.js"), ...args], { encoding: "utf8", env: { ...process.env, DATABASE_URL: url } })
}

const RUN = randomUUID().slice(0, 8)
const ids = {
  a: `c-pra-${RUN}`, b: `c-prb-${RUN}`, sa: `u-prsa-${RUN}`, admin: `u-pradm-${RUN}`, clA: `cl-pra-${RUN}`, clB: `cl-prb-${RUN}`,
  w1: `w-pr1-${RUN}`, w2: `w-pr2-${RUN}`, w3: `w-pr3-${RUN}`, wB: `w-prb-${RUN}`,
}
const HISTORIC = "historique@client.example"
const r = (email: string, active = true, label: string | null = null): PhotoRecipientInput => ({ email, active, label })
const data = (name = "Chantier test") => ({ name, description: null, address: null, clientId: ids.clA, startDate: null, endDate: null, dailyHours: 8, latitude: null, longitude: null })

describe("destinataires des photos × PostgreSQL jetable", () => {
  let prisma: PrismaClient
  const save = (worksiteId: string, recipients: PhotoRecipientInput[], over: Partial<{ actorUserId: string; companyId: string; data: ReturnType<typeof data> }> = {}) =>
    updateWorksiteWithPhotoRecipients(prisma, { companyId: ids.a, actorUserId: ids.sa, worksiteId, data: data(), recipients, ...over })
  const rows = (worksiteId: string) => prisma.worksitePhotoRecipient.findMany({ where: { worksiteId }, orderBy: { position: "asc" } })
  const worksite = (id: string) => prisma.worksite.findUniqueOrThrow({ where: { id }, select: { clientContact: true, photoRecipientsConfiguredAt: true, name: true } })
  const events = (worksiteId: string) => prisma.worksitePhotoEvent.findMany({ where: { worksiteId, action: "RECIPIENTS_SET" }, orderBy: { createdAt: "asc" } })

  before(async () => {
    const url = disposableUrl()
    // Rollback NON destructif à vide, puis ré-application : la migration est réversible tant qu'aucune configuration n'existe.
    const rollback = prismaCli(url, ["db", "execute", "--url", url, "--file", path.join(process.cwd(), `prisma/migrations/${MIGRATION}/ROLLBACK.sql`)])
    assert.equal(rollback.status, 0, `rollback à vide en échec : ${rollback.stderr.slice(-1500)}`)
    const deploy = prismaCli(url, ["migrate", "deploy"])
    assert.equal(deploy.status, 0, `ré-application en échec : ${deploy.stderr.slice(-1500)}`)
    assert.match(deploy.stdout, new RegExp(MIGRATION))
    prisma = new PrismaClient({ datasources: { db: { url } } })
    const x = (sql: string) => prisma.$executeRawUnsafe(sql)
    await x(`INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('${ids.a}','PR A','pra-${RUN}',now()),('${ids.b}','PR B','prb-${RUN}',now())`)
    await x(`INSERT INTO "users" ("id","email","name","password","role","companyId","updatedAt") VALUES
      ('${ids.sa}','prsa-${RUN}@example.test','Super Admin test','x','SUPER_ADMIN','${ids.a}',now()),
      ('${ids.admin}','pradm-${RUN}@example.test','Admin test','x','ADMIN','${ids.a}',now())`)
    await x(`INSERT INTO "clients" ("id","name","companyId","updatedAt","email") VALUES ('${ids.clA}','Client A','${ids.a}',now(),'compta@client.example'),('${ids.clB}','Client B','${ids.b}',now(),NULL)`)
    await x(`INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","updatedAt","clientContact") VALUES
      ('${ids.w1}','Chantier 1','${ids.clA}','${ids.a}','${ids.sa}',now(),'${HISTORIC}'),
      ('${ids.w2}','Chantier 2','${ids.clA}','${ids.a}','${ids.sa}',now(),NULL),
      ('${ids.w3}','Chantier 3','${ids.clA}','${ids.a}','${ids.sa}',now(),NULL),
      ('${ids.wB}','Chantier B','${ids.clB}','${ids.b}','${ids.sa}',now(),NULL)`)
  })
  after(async () => { await prisma?.$disconnect() })

  it("premier enregistrement d'une liste VIDE : chantier marqué configuré, audit unique sans adresse, clientContact intact", async () => {
    const before = await worksite(ids.w1)
    assert.equal(before.photoRecipientsConfiguredAt, null)
    assert.equal(initialRecipientState({ recipients: [], configuredAt: before.photoRecipientsConfiguredAt, clientContact: before.clientContact }).historicSuggestion, HISTORIC)
    const result = await save(ids.w1, [])
    assert.deepEqual(result, { ok: true, changed: true, diff: { added: 0, removed: 0, updated: 0, firstConfiguration: true } })
    const after = await worksite(ids.w1)
    assert.ok(after.photoRecipientsConfiguredAt)
    assert.equal(after.clientContact, HISTORIC, "adresse historique conservée, jamais effacée")
    assert.equal(initialRecipientState({ recipients: [], configuredAt: after.photoRecipientsConfiguredAt, clientContact: after.clientContact }).historicSuggestion, null)
    const audit = await events(ids.w1)
    assert.equal(audit.length, 1)
    assert.equal(JSON.stringify(audit[0]).includes("@"), false, "aucune adresse dans l'audit")
    assert.equal(audit[0].actorNameSnapshot, "Super Admin test")
  })

  it("plusieurs destinataires, désactivation sans effacement, différence stable (identifiants conservés), marqueur posé une fois", async () => {
    const firstMarker = (await worksite(ids.w1)).photoRecipientsConfiguredAt
    await save(ids.w1, [r("absente@client.example", true, "Conductrice de travaux"), r("resp@client.example", true, "Responsable"), r("direction@client.example", true, "Directeur d'exploitation")])
    const created = await rows(ids.w1)
    assert.deepEqual(created.map((x) => [x.email, x.active, x.position]), [["absente@client.example", true, 0], ["resp@client.example", true, 1], ["direction@client.example", true, 2]])
    assert.ok(created.every((x) => x.createdById === ids.sa && x.emailKey === x.email.toLowerCase()))
    // Destinataire en congé : désactivée, adresse conservée ; les deux responsables restent actifs.
    const result = await save(ids.w1, [r("absente@client.example", false, "Conductrice de travaux"), r("resp@client.example", true, "Responsable"), r("direction@client.example", true, "Directeur d'exploitation")])
    assert.deepEqual(result, { ok: true, changed: true, diff: { added: 0, removed: 0, updated: 1, firstConfiguration: false } })
    const updated = await rows(ids.w1)
    assert.deepEqual(updated.map((x) => x.id), created.map((x) => x.id), "identifiants stables")
    assert.deepEqual(updated.map((x) => x.active), [false, true, true])
    assert.deepEqual((await worksite(ids.w1)).photoRecipientsConfiguredAt, firstMarker, "marqueur posé une seule fois")
    const noChange = await save(ids.w1, [r("absente@client.example", false, "Conductrice de travaux"), r("resp@client.example", true, "Responsable"), r("direction@client.example", true, "Directeur d'exploitation")])
    assert.deepEqual(noChange, { ok: true, changed: false, diff: { added: 0, removed: 0, updated: 0, firstConfiguration: false } })
  })

  it("réorganisation, changement de casse et remplacement complet : aucun conflit transitoire", async () => {
    const before = await rows(ids.w1)
    await save(ids.w1, [r("Direction@Client.example", true, "Directeur d'exploitation"), r("resp@client.example"), r("absente@client.example", false)])
    const reordered = await rows(ids.w1)
    assert.deepEqual(reordered.map((x) => x.email), ["Direction@Client.example", "resp@client.example", "absente@client.example"])
    assert.equal(reordered[0].id, before.find((x) => x.emailKey === "direction@client.example")!.id, "même destinataire, casse mise à jour")
    const replacement = Array.from({ length: 20 }, (_, i) => r(`nouveau${i}@client.example`, i % 2 === 0))
    const result = await save(ids.w1, replacement)
    assert.equal(result.ok, true)
    assert.equal((await rows(ids.w1)).length, 20)
    await save(ids.w1, [...replacement].reverse())
    assert.deepEqual((await rows(ids.w1)).map((x) => x.email), [...replacement].reverse().map((x) => x.email))
  })

  it("vider → recharger → réenregistrer : la liste vide reste vide, l'adresse historique n'est jamais réactivée", async () => {
    const cleared = await save(ids.w1, [])
    assert.equal(cleared.ok && cleared.diff.removed, 20)
    assert.equal((await rows(ids.w1)).length, 0)
    const reloaded = await worksite(ids.w1)
    const state = initialRecipientState({ recipients: [], configuredAt: reloaded.photoRecipientsConfiguredAt, clientContact: reloaded.clientContact })
    const resubmitted = state.rows.map((x) => r(x.email, x.active, x.label || null))
    assert.equal(state.historicSuggestion, null)
    assert.equal(resubmitted.length, 0)
    const resaved = await save(ids.w1, resubmitted)
    assert.deepEqual(resaved, { ok: true, changed: false, diff: { added: 0, removed: 0, updated: 0, firstConfiguration: false } })
    assert.equal((await rows(ids.w1)).length, 0)
    assert.equal((await worksite(ids.w1)).clientContact, HISTORIC)
  })

  it("autorité relue : compte ADMIN refusé, compte désactivé refusé ; rien n'est écrit", async () => {
    assert.deepEqual(await save(ids.w2, [r("x@client.example")], { actorUserId: ids.admin }), { ok: false, code: "FORBIDDEN" })
    await prisma.user.update({ where: { id: ids.sa }, data: { active: false } })
    try {
      assert.deepEqual(await save(ids.w2, [r("x@client.example")]), { ok: false, code: "FORBIDDEN" })
    } finally {
      await prisma.user.update({ where: { id: ids.sa }, data: { active: true } })
    }
    assert.equal((await rows(ids.w2)).length, 0)
    assert.equal((await worksite(ids.w2)).photoRecipientsConfiguredAt, null)
  })

  it("isolation : chantier d'une autre entreprise ⇒ introuvable, aucune écriture ; FK composite refuse un destinataire cross-tenant", async () => {
    assert.deepEqual(await save(ids.wB, [r("x@client.example")]), { ok: false, code: "WORKSITE_NOT_FOUND" })
    assert.equal((await rows(ids.wB)).length, 0)
    await assert.rejects(prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_recipients" ("id","companyId","worksiteId","email","emailKey","position","createdById","updatedById") VALUES ('x-${RUN}','${ids.a}','${ids.wB}','x@client.example','x@client.example',0,'u','u')`))
  })

  it("atomicité : échec APRÈS des écritures (2e destinataire refusé par la base) ⇒ ni chantier modifié, ni destinataire, ni marqueur, ni audit", async () => {
    // Entrée volontairement hors du lecteur de formulaire : la contrainte SQL refuse la 2e ligne après l'écriture du chantier,
    // du marqueur et de la 1re ligne ; tout doit être annulé.
    await assert.rejects(save(ids.w3, [r("x@client.example"), r("pas valide@client.example")], { data: data("Nom qui ne doit pas rester") }), /values_check/)
    assert.equal((await rows(ids.w3)).length, 0)
    const w3 = await worksite(ids.w3)
    assert.equal(w3.photoRecipientsConfiguredAt, null)
    assert.equal(w3.name, "Chantier 3")
    assert.equal((await events(ids.w3)).length, 0)
  })

  it("contraintes SQL : forme d'adresse, clé en minuscules, nom vide, doublon de casse, 21e destinataire refusés", async () => {
    const insert = (id: string, email: string, key: string, position: number, label = "NULL") =>
      prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_recipients" ("id","companyId","worksiteId","label","email","emailKey","position","createdById","updatedById") VALUES ('${id}-${RUN}','${ids.a}','${ids.w2}',${label},'${email}','${key}',${position},'u','u')`)
    await assert.rejects(insert("bad1", "a b@client.example", "a b@client.example", 0), /values_check/)
    await assert.rejects(insert("bad2", "A@client.example", "A@client.example", 0), /values_check/)
    await assert.rejects(insert("bad3", "a@client.example", "a@client.example", 0, "'  '"), /values_check/)
    await assert.rejects(insert("bad4", "a@client.example", "a@client.example", 20), /values_check/)
    for (let i = 0; i < 19; i++) await insert(`ok${i}`, `p${i}@client.example`, `p${i}@client.example`, i)
    await assert.rejects(insert("dup", "P0@client.example", "p0@client.example", 0), /23505|already exists/, "même adresse, autre casse")
    await insert("ok19", "p19@client.example", "p19@client.example", 19)
    await assert.rejects(insert("over", "p20@client.example", "p20@client.example", 0), /20 destinataires au plus/)
  })

  it("borne de 20 sous concurrence, HORS service : deux insertions directes simultanées sur 19 ⇒ une seule réussit", async () => {
    for (let i = 0; i < 19; i++) {
      await prisma.$executeRawUnsafe(`INSERT INTO "worksite_photo_recipients" ("id","companyId","worksiteId","email","emailKey","position","createdById","updatedById") VALUES ('c${i}-${RUN}','${ids.a}','${ids.w3}','c${i}@client.example','c${i}@client.example',${i},'u','u')`)
    }
    const attempt = (n: number, delayMs: number) => new Promise<string>((resolve) => setTimeout(resolve, delayMs)).then(() => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "worksite_photo_recipients" ("id","companyId","worksiteId","email","emailKey","position","createdById","updatedById") VALUES ('race${n}-${RUN}','${ids.a}','${ids.w3}','race${n}@client.example','race${n}@client.example',19,'u','u')`)
      await tx.$queryRawUnsafe(`SELECT pg_sleep(0.4)::text AS "slept"`) // garde le verrou du chantier pendant que l'autre insertion attend
      return "ok"
    }, { timeout: 10_000 }))
    const settled = await Promise.allSettled([attempt(1, 0), attempt(2, 100)])
    assert.equal(settled.filter((x) => x.status === "fulfilled").length, 1, `une seule insertion passe : ${settled.map((x) => x.status === "rejected" ? String(x.reason).slice(-200) : "ok").join(" | ")}`)
    const refused = settled.find((x) => x.status === "rejected") as PromiseRejectedResult
    assert.match(String(refused.reason), /20 destinataires au plus/)
    assert.equal(await prisma.worksitePhotoRecipient.count({ where: { worksiteId: ids.w3 } }), 20)
  })

  it("ROLLBACK refusé dès qu'une configuration existe (même une liste vidée) ; rien n'est retiré", async () => {
    const url = disposableUrl()
    const run = prismaCli(url, ["db", "execute", "--url", url, "--file", path.join(process.cwd(), `prisma/migrations/${MIGRATION}/ROLLBACK.sql`)])
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /ROLLBACK REFUSÉ/)
    assert.ok((await worksite(ids.w1)).photoRecipientsConfiguredAt)
  })
})
