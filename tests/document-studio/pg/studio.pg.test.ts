/**
 * Lot G Planificator V2 : Document Studio sur une base PostgreSQL JETABLE. Brouillon, publication figée, version
 * suivante et retrait, génération avec champs manquants refusés, numérotation concurrente, génération reproductible,
 * circuit de validation (autre administrateur, signature), refus, isolation et garanties de la base.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh lotg_studio npm run test:studio:pg
 * Portage sur ef36578f (19/11/2026) : deux entreprises isolées (coA, coB), trois utilisateurs réels (uA, uA2, uB) pour la
 * clé history_logs_actorId_fkey, aucun littéral BigInt (cible ES2017) ; durcissements IS NOT NULL de la v6 contrôlés par le
 * CHECK seul (valeurs présentes acceptées, valeurs nulles refusées). Base jetable uniquement (Mac), jamais sur le VPS.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as svc from "@/lib/document-studio/studio.service"
import { getGeneratedDocument } from "@/lib/document-studio/queries"
import { STUDIO_ERRORS, documentSha256, readFields, renderDocument, type FieldDef } from "@/lib/document-studio/studio.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const A2 = { companyId: "coA", userId: "uA2" }
const B = { companyId: "coB", userId: "uB" }
const T0 = new Date("2026-11-04T08:00:00Z")
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)])
const SIG = `data:image/png;base64,${PNG.toString("base64")}`
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const FIELDS: FieldDef[] = [{ key: "nature", label: "Nature des travaux", type: "TEXT", required: true }, { key: "montant", label: "Montant", type: "AMOUNT", required: true }]
const CONTENT = { title: "Attestation {{numero}}", body: "# Objet\nTravaux de {{nature}} pour {{client}} ({{chantier}}), montant {{montant}}.", fields: FIELDS, requiresApproval: true }
let tpl = "", v1 = "", doc1 = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','BTP A','a',now()),('coB','BTP B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uA2','a2@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','Durand',now()),('clB','coB','Client B',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','uA','Maison A',now()),('wB','coB','clB','uB','Maison B',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("modèles et versions", () => {
  it("création en brouillon ; nom unique par entreprise ; contenu incohérent refusé ; aucune génération sans version publiée", async () => {
    const r = ok(await svc.createTemplate(db, A, { name: "Attestation de travaux", category: "CERTIFICATE", ...CONTENT }))
    tpl = r.templateId; v1 = r.versionId
    assert.deepEqual(await svc.createTemplate(db, A, { name: "Attestation de travaux", category: "CERTIFICATE", ...CONTENT }), { ok: false, error: STUDIO_ERRORS.duplicateName })
    ok(await svc.createTemplate(db, B, { name: "Attestation de travaux", category: "CERTIFICATE", ...CONTENT }))
    assert.deepEqual(await svc.createTemplate(db, A, { name: "Autre", category: "LETTER", ...CONTENT, body: "{{inconnu}} {{nature}} {{montant}}" }), { ok: false, error: STUDIO_ERRORS.undeclared(["inconnu"]) })
    assert.deepEqual(await svc.generateDocument(db, A, tpl, { values: { nature: "x", montant: "1" } }, T0), { ok: false, error: STUDIO_ERRORS.noPublished })
  })
  it("brouillon modifiable ; publication : empreinte fixée, version figée (service et base)", async () => {
    ok(await svc.updateDraft(db, A, v1, { ...CONTENT, body: `${CONTENT.body}\n\nFait pour valoir ce que de droit.` }))
    const p = ok(await svc.publishVersion(db, A, v1, T0))
    assert.match(p.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(await svc.publishVersion(db, A, v1, T0), { ok: false, error: STUDIO_ERRORS.notDraft })
    assert.deepEqual(await svc.updateDraft(db, A, v1, CONTENT), { ok: false, error: STUDIO_ERRORS.notDraft })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE document_template_versions SET body = 'modifié' WHERE id = '${v1}'`), /published document template version immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE document_template_versions SET status = 'DRAFT', "contentSha256" = NULL, "publishedById" = NULL, "publishedAt" = NULL WHERE id = '${v1}'`), /immutable|transition not allowed/)
  })
})

describe("génération et validation", () => {
  it("champs manquants ou inconnus refusés ; liens d'une autre entreprise refusés ; rien n'est créé", async () => {
    assert.deepEqual(await svc.generateDocument(db, A, tpl, { values: { nature: "" } }, T0), { ok: false, error: STUDIO_ERRORS.missing(["Nature des travaux", "Montant"]) })
    assert.deepEqual(await svc.generateDocument(db, A, tpl, { values: { nature: "x", montant: "1", intrus: "y" } }, T0), { ok: false, error: STUDIO_ERRORS.unknown(["intrus"]) })
    assert.deepEqual(await svc.generateDocument(db, A, tpl, { values: { nature: "x", montant: "1" }, clientId: "clB" }, T0), { ok: false, error: STUDIO_ERRORS.notFound })
    assert.equal(await db.generatedDocument.count(), 0)
  })
  it("document en attente de validation, numéroté, instantané intact et reproductible depuis la version et les valeurs", async () => {
    const r = ok(await svc.generateDocument(db, A, tpl, { values: { nature: "peinture", montant: "1 234,5" }, clientId: "clA", worksiteId: "wA" }, T0))
    doc1 = r.id
    assert.deepEqual([r.number, r.status], ["DOC-2026-0001", "PENDING_APPROVAL"])
    const d = await getGeneratedDocument(db, "coA", doc1)
    assert.ok(d && d.intact && d.snapshot)
    assert.equal(d!.snapshot!.title, "Attestation DOC-2026-0001")
    assert.deepEqual(d!.snapshot!.blocks[1], { kind: "paragraph", text: "Travaux de peinture pour Durand (Maison A), montant 1 234,50 €." })
    const v = await db.documentTemplateVersion.findUniqueOrThrow({ where: { id: v1 }, select: { title: true, body: true, fields: true, requiresApproval: true, version: true, contentSha256: true } })
    const row = await db.generatedDocument.findUniqueOrThrow({ where: { id: doc1 }, select: { values: true, snapshotSha256: true } })
    const again = renderDocument({ title: v.title, body: v.body, fields: readFields(v.fields)!, requiresApproval: v.requiresApproval }, row.values as Record<string, string>,
      { entreprise: "BTP A", numero: "DOC-2026-0001", date_document: "2026-11-04", client: "Durand", chantier: "Maison A" }, { templateName: "Attestation de travaux", version: v.version, versionSha256: v.contentSha256! })
    assert.equal(documentSha256(again), row.snapshotSha256, "même version et mêmes valeurs ⇒ même empreinte")
  })
  it("validation : refusée à l'auteur ; par un autre administrateur avec signature ; décision unique", async () => {
    assert.deepEqual(await svc.approveDocument(db, A, doc1, { signerName: "Ana Martin", signature: SIG }, T0), { ok: false, error: STUDIO_ERRORS.selfApproval })
    assert.equal((await svc.approveDocument(db, A2, doc1, { signerName: "Léo Petit", signature: "data:image/png;base64,AAAA" }, T0)).ok, false, "signature invalide")
    ok(await svc.approveDocument(db, A2, doc1, { signerName: "Léo Petit", signature: SIG }, T0))
    const d = await getGeneratedDocument(db, "coA", doc1)
    assert.deepEqual([d!.status, d!.signerName, d!.signaturePng?.equals(PNG), d!.intact], ["ISSUED", "Léo Petit", true, true])
    assert.deepEqual(await svc.approveDocument(db, A2, doc1, { signerName: "Léo Petit", signature: SIG }, T0), { ok: false, error: STUDIO_ERRORS.notPending })
    assert.deepEqual(await svc.rejectDocument(db, A2, doc1, "Trop tard", T0), { ok: false, error: STUDIO_ERRORS.notPending })
    assert.equal(await db.historyLog.count({ where: { companyId: "coA", entityType: "GeneratedDocument", entityId: doc1 } }), 2)
  })
  it("refus motivé ; isolation : une autre entreprise ne voit ni ne décide rien", async () => {
    const r = ok(await svc.generateDocument(db, A, tpl, { values: { nature: "toiture", montant: "10" } }, T0))
    assert.deepEqual(await svc.approveDocument(db, B, r.id, { signerName: "Bob", signature: SIG }, T0), { ok: false, error: STUDIO_ERRORS.notFound })
    assert.deepEqual(await svc.rejectDocument(db, B, r.id, "Motif", T0), { ok: false, error: STUDIO_ERRORS.notFound })
    assert.equal(await getGeneratedDocument(db, "coB", r.id), null)
    assert.deepEqual(await svc.generateDocument(db, B, tpl, { values: { nature: "x", montant: "1" } }, T0), { ok: false, error: STUDIO_ERRORS.notFound })
    assert.deepEqual(await svc.rejectDocument(db, A2, r.id, "ab", T0), { ok: false, error: STUDIO_ERRORS.reason })
    assert.deepEqual(await svc.rejectDocument(db, A, r.id, "Je retire mon document", T0), { ok: false, error: STUDIO_ERRORS.selfApproval }, "l'auteur ne refuse pas non plus")
    ok(await svc.rejectDocument(db, A2, r.id, "Montant à confirmer", T0))
    assert.equal((await db.generatedDocument.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } })).status, "REJECTED")
  })
  it("version suivante : un seul brouillon ; publication retire la précédente ; anciens documents inchangés ; émission directe sans validation", async () => {
    const v2 = ok(await svc.createDraft(db, A, tpl)).versionId
    assert.deepEqual(await svc.createDraft(db, A, tpl), { ok: false, error: STUDIO_ERRORS.draftExists })
    ok(await svc.updateDraft(db, A, v2, { ...CONTENT, requiresApproval: false }))
    ok(await svc.publishVersion(db, A, v2, T0))
    const vs = await db.documentTemplateVersion.findMany({ where: { templateId: tpl }, orderBy: { version: "asc" }, select: { version: true, status: true } })
    assert.deepEqual(vs.map((v) => [v.version, v.status]), [[1, "RETIRED"], [2, "PUBLISHED"]])
    const r = ok(await svc.generateDocument(db, A, tpl, { values: { nature: "isolation", montant: "5" } }, T0))
    assert.equal(r.status, "ISSUED")
    const old = await getGeneratedDocument(db, "coA", doc1)
    assert.deepEqual([old!.intact, old!.snapshot!.template.version], [true, 1], "le document émis reste celui de la version 1")
  })
  it("validations concurrentes d'un même document : une seule gagne", async () => {
    const t2 = ok(await svc.createTemplate(db, A, { name: "Attestation bis", category: "CERTIFICATE", ...CONTENT }))
    ok(await svc.publishVersion(db, A, t2.versionId, T0))
    const d = ok(await svc.generateDocument(db, A, t2.templateId, { values: { nature: "x", montant: "1" } }, T0))
    const rs = await Promise.all([1, 2, 3].map(() => svc.approveDocument(db, A2, d.id, { signerName: "Léo Petit", signature: SIG }, T0)))
    assert.equal(rs.filter((r) => r.ok).length, 1)
    assert.ok(rs.filter((r) => !r.ok).every((r) => !r.ok && r.error === STUDIO_ERRORS.notPending))
  })
  it("générations concurrentes : numéros distincts et consécutifs", async () => {
    const rs = await Promise.all([1, 2, 3].map(() => svc.generateDocument(db, A, tpl, { values: { nature: "n", montant: "1" } }, T0)))
    const numbers = rs.map((r) => ok(r).number).sort()
    assert.deepEqual(numbers, ["DOC-2026-0005", "DOC-2026-0006", "DOC-2026-0007"], "0004 pris par le test des validations concurrentes")
  })
})

describe("garanties de la base", () => {
  it("version née brouillon ; un seul brouillon ; document seulement d'une version publiée, dans l'état imposé", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO document_template_versions(id,"companyId","templateId",version,status,title,body,fields,"contentSha256","createdById","publishedById","publishedAt","updatedAt") VALUES ('vx','coA','${tpl}',9,'PUBLISHED','Titre','Corps','[]','${"a".repeat(64)}','uA','uA',now(),now())`), /must start as draft/)
    ok(await svc.createDraft(db, A, tpl))
    // v2 (recette Codex) : second brouillon refusé par l'index unique partiel ; PostgreSQL rend le SQLSTATE 23505 (exposé par
    // Prisma dans meta.code) et la clé en conflit « templateId ». Aucune autre erreur n'est acceptée.
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO document_template_versions(id,"companyId","templateId",version,title,body,fields,"createdById","updatedAt") VALUES ('vy','coA','${tpl}',10,'Titre','Corps','[]','uA',now())`), (e: unknown) => {
      const meta = (e as { meta?: { code?: unknown; message?: unknown } }).meta
      assert.equal(meta?.code, "23505", `SQLSTATE attendu 23505 : ${String(meta?.code)}`)
      const detail = `${String(meta?.message ?? "")}\n${e instanceof Error ? e.message : ""}`
      assert.match(detail, /\btemplateId\b/, "clé en conflit : templateId")
      return true
    })
    const ins = (versionId: string, status: string) => db.$executeRawUnsafe(`INSERT INTO generated_documents(id,"companyId","versionId",number,title,values,snapshot,"snapshotSha256",status,"createdById","updatedAt") VALUES ('dx','coA','${versionId}','DOC-2026-9999','T','{}','{}','${"b".repeat(64)}','${status}','uA',now())`)
    await assert.rejects(ins(v1, "PENDING_APPROVAL"), /requires a published version/, "version 1 retirée")
    const v2 = (await db.documentTemplateVersion.findFirstOrThrow({ where: { templateId: tpl, status: "PUBLISHED" }, select: { id: true } })).id
    await assert.rejects(ins(v2, "PENDING_APPROVAL"), /initial status mismatch/, "la version 2 n'exige pas de validation")
  })
  it("publication en SQL direct sans empreinte de contenu : refusée par le CHECK (revue Codex du 05/11)", async () => {
    const t = ok(await svc.createTemplate(db, A, { name: "Sans empreinte", category: "OTHER", ...CONTENT }))
    await assert.rejects(db.$executeRawUnsafe(`UPDATE document_template_versions SET status = 'PUBLISHED', "contentSha256" = NULL, "publishedById" = 'uA', "publishedAt" = now() WHERE id = '${t.versionId}'`), /document_template_versions_values_check/)
    assert.equal((await db.documentTemplateVersion.findUniqueOrThrow({ where: { id: t.versionId }, select: { status: true } })).status, "DRAFT")
  })
  it("contenu d'un document figé, décision unique, auteur ≠ valideur, jamais supprimé ; modèle jamais supprimé", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET title = 'Autre' WHERE id = '${doc1}'`), /content immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET status = 'REJECTED', "approvedById" = NULL, "approvedAt" = NULL, "signerName" = NULL, "signaturePng" = NULL, "signatureSha256" = NULL, "rejectedById" = 'uA2', "rejectedAt" = now(), "rejectReason" = 'Après coup' WHERE id = '${doc1}'`), /already decided/)
    const p = ok(await svc.createTemplate(db, A, { name: "Courrier", category: "LETTER", ...CONTENT }))
    ok(await svc.publishVersion(db, A, p.versionId, T0))
    const d = ok(await svc.generateDocument(db, A, p.templateId, { values: { nature: "x", montant: "1" } }, T0))
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET status = 'ISSUED', "approvedById" = 'uA', "approvedAt" = now(), "signerName" = 'Ana', "signaturePng" = '\\x89504e47', "signatureSha256" = '${"c".repeat(64)}' WHERE id = '${d.id}'`), /generated_documents_values_check/, "l'auteur ne valide pas son propre document")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET status = 'ISSUED' WHERE id = '${d.id}'`), /approval requires a signature/, "en attente → émis sans signature refusé")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET status = 'REJECTED', "rejectedById" = 'uA', "rejectedAt" = now(), "rejectReason" = 'Motif' WHERE id = '${d.id}'`), /generated_documents_values_check/, "l'auteur ne refuse pas son propre document")
    // Revue Codex du 05/11 : validation sans empreinte de signature refusée (déclencheur, et CHECK avec IS NOT NULL explicite).
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET status = 'ISSUED', "approvedById" = 'uA2', "approvedAt" = now(), "signerName" = 'Léo', "signaturePng" = '\\x89504e47', "signatureSha256" = NULL WHERE id = '${d.id}'`), /approval requires a signature|generated_documents_values_check/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM generated_documents WHERE id = '${doc1}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM document_templates WHERE id = '${tpl}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM document_template_versions WHERE id = '${v1}'`), /cannot be deleted/)
  })
  it("durcissements v6 (IS NOT NULL) : valeurs présentes acceptées ; valeurs nulles refusées par le CHECK seul", async () => {
    // Valeurs présentes : version retirée (v1) et publiée empreintes, document validé avec empreinte de sa signature.
    const vs = await db.documentTemplateVersion.findMany({ where: { templateId: tpl, status: { in: ["PUBLISHED", "RETIRED"] } }, select: { status: true, contentSha256: true } })
    assert.deepEqual(vs.map((v) => v.status).sort(), ["PUBLISHED", "RETIRED"])
    for (const v of vs) assert.match(v.contentSha256 ?? "", /^[0-9a-f]{64}$/, v.status)
    const signed = await db.generatedDocument.findUniqueOrThrow({ where: { id: doc1 }, select: { status: true, signatureSha256: true } })
    assert.deepEqual([signed.status, signed.signatureSha256], ["ISSUED", createHash("sha256").update(PNG).digest("hex")])
    // Valeurs nulles : déclencheur suspendu DANS une transaction annulée (ALTER TABLE transactionnel), pour que seul le CHECK juge.
    const checkSeul = (table: string, trigger: string, update: string) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
      await tx.$executeRawUnsafe(update)
    })
    const draft = ok(await svc.createTemplate(db, A, { name: "Contrôle CHECK", category: "OTHER", ...CONTENT }))
    await assert.rejects(checkSeul("document_template_versions", "document_template_versions_guard", `UPDATE document_template_versions SET status = 'PUBLISHED', "contentSha256" = NULL, "publishedById" = 'uA', "publishedAt" = now() WHERE id = '${draft.versionId}'`), /document_template_versions_values_check/, "PUBLISHED sans empreinte")
    await assert.rejects(checkSeul("document_template_versions", "document_template_versions_guard", `UPDATE document_template_versions SET "contentSha256" = NULL WHERE id = '${v1}'`), /document_template_versions_values_check/, "RETIRED sans empreinte")
    await assert.rejects(checkSeul("generated_documents", "generated_documents_guard", `UPDATE generated_documents SET "signatureSha256" = NULL WHERE id = '${doc1}'`), /generated_documents_values_check/, "ISSUED validé sans empreinte de signature")
    // Transactions annulées : déclencheurs rétablis, valeurs intactes.
    await assert.rejects(db.$executeRawUnsafe(`UPDATE document_template_versions SET body = 'modifié' WHERE id = '${v1}'`), /published document template version immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE generated_documents SET title = 'Autre' WHERE id = '${doc1}'`), /content immutable/)
    assert.equal((await db.generatedDocument.findUniqueOrThrow({ where: { id: doc1 }, select: { signatureSha256: true } })).signatureSha256, signed.signatureSha256)
    assert.equal((await db.documentTemplateVersion.findUniqueOrThrow({ where: { id: draft.versionId }, select: { status: true } })).status, "DRAFT")
  })
})

// Lot G2 (22/11/2026) — ajoutés sur le VPS SANS exécution (aucune base jetable sur le VPS) : à lancer sur le Mac avec la
// commande d'en-tête avant toute fusion.
describe("lot G2 : champs enrichis, champs système étendus, duplication, recherche", () => {
  const G2_FIELDS: FieldDef[] = [
    { key: "decision", label: "Décision", type: "CHOICE", required: true, options: ["sans réserve", "avec réserves"] },
    { key: "accord", label: "Accord du client", type: "CHECKBOX", required: false },
  ]
  const G2 = { title: "PV {{numero}}", body: "# Réception\n**{{client}}**, {{client_adresse}} — chantier {{chantier_adresse}}, début {{chantier_debut}}.\n\n- Décision : {{decision}}\n- Accord : {{accord}}\n\n| Émetteur | SIRET |\n| {{entreprise}} | {{entreprise_siret}} |", fields: G2_FIELDS, requiresApproval: false }
  let g2 = ""
  it("génération : liste de choix contrôlée, case à cocher, coordonnées lues en base et figées dans l'instantané", async () => {
    await db.$executeRawUnsafe(`UPDATE companies SET address = '1 rue A, Paris', siret = '12345678900012' WHERE id = 'coA'`)
    await db.$executeRawUnsafe(`UPDATE clients SET address = '2 rue B, Lyon' WHERE id = 'clA'`)
    await db.$executeRawUnsafe(`UPDATE worksites SET address = '3 rue C, Lille', "startDate" = '2026-11-02T00:00:00Z' WHERE id = 'wA'`)
    const t = ok(await svc.createTemplate(db, A, { name: "PV de réception", category: "REPORT", ...G2 }))
    g2 = t.templateId
    ok(await svc.publishVersion(db, A, t.versionId, T0))
    assert.deepEqual(await svc.generateDocument(db, A, g2, { values: { decision: "autre" } }, T0), { ok: false, error: STUDIO_ERRORS.invalidValue("Décision") })
    const r = ok(await svc.generateDocument(db, A, g2, { values: { decision: "avec réserves", accord: "oui" }, clientId: "clA", worksiteId: "wA" }, T0))
    const d = await getGeneratedDocument(db, "coA", r.id)
    assert.ok(d?.intact && d.snapshot)
    assert.deepEqual(d.snapshot.issuer, { address: "1 rue A, Paris", siret: "12345678900012" })
    assert.deepEqual(d.snapshot.blocks.map((b) => b.kind), ["heading", "paragraph", "list", "table"])
    assert.equal(d.snapshot.blocks[1].text, "Durand, 2 rue B, Lyon — chantier 3 rue C, Lille, début 2 novembre 2026.")
    assert.deepEqual(d.snapshot.blocks[2].items?.map((i) => i.text), ["Décision : avec réserves", "Accord : Oui"])
    assert.deepEqual(d.snapshot.blocks[3].rows, [["Émetteur", "SIRET"], ["BTP A", "12345678900012"]])
    assert.deepEqual(await db.generatedDocument.findUniqueOrThrow({ where: { id: r.id }, select: { values: true } }), { values: { decision: "avec réserves", accord: "oui" } })
  })
  it("duplication : nouveau modèle « (copie) » en brouillon v1, contenu de la dernière version ; isolée par entreprise", async () => {
    const c = ok(await svc.duplicateTemplate(db, A, g2))
    const copy = await db.documentTemplate.findUniqueOrThrow({ where: { id: c.templateId }, select: { name: true, category: true, companyId: true, versions: { select: { version: true, status: true, body: true, fields: true } } } })
    assert.deepEqual([copy.name, copy.category, copy.companyId], ["PV de réception (copie)", "REPORT", "coA"])
    assert.deepEqual(copy.versions.map((v) => [v.version, v.status, v.body]), [[1, "DRAFT", G2.body]])
    assert.deepEqual(readFields(copy.versions[0].fields), G2_FIELDS)
    assert.equal((await db.documentTemplate.findUniqueOrThrow({ where: { id: ok(await svc.duplicateTemplate(db, A, g2)).templateId }, select: { name: true } })).name, "PV de réception (copie 2)")
    assert.deepEqual(await svc.duplicateTemplate(db, B, g2), { ok: false, error: STUDIO_ERRORS.notFound })
  })
  it("recherche et réutilisation : filtrées par société dans la requête ; document d'un autre modèle refusé", async () => {
    const { listGeneratedDocuments, getDocumentForReuse } = await import("@/lib/document-studio/queries")
    const found = await listGeneratedDocuments(db, "coA", 50, { q: "pv de réc" })
    assert.ok(found.length >= 1 && found.every((d) => d.version.template.name === "PV de réception"))
    assert.deepEqual(await listGeneratedDocuments(db, "coB", 50, { q: "pv de réc" }), [])
    assert.deepEqual(await listGeneratedDocuments(db, "coA", 50, { q: "pv", status: "REJECTED" }), [])
    assert.deepEqual((await getDocumentForReuse(db, "coA", g2, found[0].id))?.values, { decision: "avec réserves", accord: "oui" })
    assert.equal(await getDocumentForReuse(db, "coA", tpl, found[0].id), null)
    assert.equal(await getDocumentForReuse(db, "coB", g2, found[0].id), null)
  })
  // Corrections après la revue Codex du 23/11/2026 (cas NON exécutés sur le VPS : aucune base jetable).
  it("génération liée à la version affichée ; logo figé dans l'instantané, indépendant du logo courant", async () => {
    const LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    const v1 = (await db.documentTemplateVersion.findFirstOrThrow({ where: { templateId: g2, status: "PUBLISHED" }, select: { id: true } })).id
    const v2 = ok(await svc.createDraft(db, A, g2)).versionId
    ok(await svc.publishVersion(db, A, v2, T0))
    // Le formulaire affichait v1 ; v2 a été publiée entre-temps : refus, aucun document créé.
    const before = await db.generatedDocument.count({ where: { companyId: "coA" } })
    assert.deepEqual(await svc.generateDocument(db, A, g2, { versionId: v1, values: { decision: "sans réserve" } }, T0), { ok: false, error: STUDIO_ERRORS.versionChanged })
    assert.equal(await db.generatedDocument.count({ where: { companyId: "coA" } }), before)
    await db.company.update({ where: { id: "coA" }, data: { logoUrl: LOGO } })
    const r = ok(await svc.generateDocument(db, A, g2, { versionId: v2, values: { decision: "sans réserve" } }, T0))
    await db.company.update({ where: { id: "coA" }, data: { logoUrl: null } })
    const d = await getGeneratedDocument(db, "coA", r.id)
    assert.ok(d?.intact && d.snapshot)
    assert.equal(d.snapshot.logo, LOGO)
    // Sans logo géré au moment de la génération : aucune clé « logo » dans l'instantané.
    const sans = await getGeneratedDocument(db, "coA", ok(await svc.generateDocument(db, A, g2, { versionId: v2, values: { decision: "sans réserve" } }, T0)).id)
    assert.ok(sans?.intact && sans.snapshot && !("logo" in sans.snapshot))
  })
})
