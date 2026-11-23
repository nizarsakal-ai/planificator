/**
 * Lot D Planificator V2 : réserves et procès-verbaux sur une base PostgreSQL JETABLE migrée (jamais une base réelle).
 * Flux complet (constat avec preuve, levée, annulation, signature), cohérence décision / réserves, immuabilité en
 * base, isolation entre entreprises et audit, reproductibilité de l'instantané.
 *
 * Réconciliation 12/11 sur l'arbre publié b0a2523e (revue indépendante D) :
 * - responsable = libellé libre (aucune table RH lue ni écrite) ;
 * - PV figé : une modification ultérieure du chantier ou du client ne change ni l'instantané ni son empreinte ;
 * - intégrité avant rendu : altération isolée de l'instantané OU des octets de la signature ⇒ `intact` faux (route 409) ;
 * - 3 courses à BARRIÈRE DÉTERMINISTE (création, annulation, levée contre signature) : une transaction témoin tient le
 *   verrou du chantier, les deux opérations l'attendent RÉELLEMENT (constaté par pg_blocking_pids) avant la levée ;
 * - plafond : 500 réserves ouvertes ⇒ PV complet ; 501 ⇒ refus explicite sans écriture ; défense en base au-delà de 500 ;
 * - E10 : la clé RESTRICT refuse la suppression d'un chantier portant une réserve (P2003) ; un chantier sans réserve
 *   reste supprimable. L'action Chantiers n'est pas modifiée par le lot D.
 * Le rendu PDF réel est testé par tests/reserves/report-pdf.render.test.tsx.
 * Identifiants propres à ce fichier (coRA, coRB…) : les trois fichiers PG du lot D partagent la même base jetable.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { after, before, describe, it } from "node:test"
import { Prisma, PrismaClient } from "@prisma/client"
import * as svc from "@/lib/reserves/reserves.service"
import { MAX_REPORT_RESERVES, RESERVE_ERRORS, sha256Hex, snapshotSha256 } from "@/lib/reserves/reserves.core"
import { getReportForPdf, getReserveFile, getWorksiteReception } from "@/lib/reserves/queries"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

const db = new PrismaClient()
const A = { companyId: "coRA", userId: "uRA" }
const B = { companyId: "coRB", userId: "uRB" }
const NOW = new Date("2026-11-04T09:00:00Z")
/** Bloc PNG (longueur, type, données, CRC) construit sans dépendance. */
function pngChunk(type: string, body: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body])
  let c = 0xffffffff; for (const v of tb) c = table[(c ^ v) & 0xff] ^ (c >>> 8)
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, tb, crc])
}
/** PNG RÉEL et décodable au profil d'un canevas (RVBA 8 bits par défaut, non entrelacé), motif peu compressible ;
 * `colorType` et `extra` (blocs insérés avant IDAT) servent aux cas refusés. */
function makePng(width = 40, height = 20, colorType = 6, extra: Buffer[] = []): Buffer {
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1, row = 1 + width * bpp
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType
  const raw = Buffer.alloc(height * row)
  for (let y = 0; y < height; y++) for (let x = 0; x < width * bpp; x++) raw[y * row + 1 + x] = (((x * 73856093) ^ (y * 19349663)) >>> 0) & 0xff
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), ...extra, pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))])
}
const PNG = makePng()
const SIG = `data:image/png;base64,${PNG.toString("base64")}`
const ok = <T>(r: svc.ReserveResult<T>): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const report = (extra: Partial<svc.CreateReportInput> = {}): svc.CreateReportInput => ({
  worksiteId: "wRA", decision: "WITH_RESERVES", receptionDate: new Date("2026-11-04T00:00:00Z"), clientSignerName: "M. Client", companySignerName: "Mme Conductrice", signatureDataUrl: SIG, ...extra,
})
const site = (id: string, name = `Chantier ${id}`) => db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('${id}','coRA','clRA','uRA','${name}',now())`)
let r1 = "", r2 = ""
/**
 * Refus DIFFÉRÉ en base (même méthode que le lot C, correctif D r1 après preuves d1) : Prisma 5 avale l'erreur du COMMIT.
 * 1. oracle : contraintes rendues immédiates DANS la transaction ⇒ le refus est levé et propagé ;
 * 2. sans évaluation anticipée, les écritures sont acceptées (témoin `ecrit`) puis la base refuse au COMMIT : la transaction
 *    est annulée, rien n'est enregistré
 *    (la promesse de Prisma peut se résoudre : c'est précisément pourquoi le service évalue la contrainte avant le COMMIT).
 */
async function refusDiffere(ecrire: (tx: Prisma.TransactionClient) => Promise<unknown>, motif: RegExp, annule: () => Promise<boolean>) {
  await assert.rejects(db.$transaction(async (tx) => { await ecrire(tx); await flushDeferredConstraints(tx) }, { timeout: 30_000 }), motif, "oracle SQL (contraintes immédiates)")
  assert.ok(await annule(), "rien n'est enregistré après le refus immédiat")
  // Revue r1 : `ecrit` passe à vrai APRÈS les écritures ; s'il reste faux, c'est l'INSERT qui a été refusé (pas le COMMIT).
  let ecrit = false
  await db.$transaction(async (tx) => { await ecrire(tx); ecrit = true }, { timeout: 30_000 }).catch(() => undefined)
  assert.equal(ecrit, true, "écritures acceptées dans la transaction : seul le COMMIT pouvait refuser")
  assert.ok(await annule(), "refus au COMMIT : transaction annulée par la base, rien n'est enregistré")
}

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coRA','Entreprise RA','ra',now()),('coRB','Entreprise RB','rb',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uRA','ra@reserves.test','x',now()),('uRB','rb@reserves.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clRA','coRA','Client RA',now()),('clRB','coRB','Client RB',now())`,
    `INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wRA','coRA','clRA','uRA','Chantier RA',now()),('wRA2','coRA','clRA','uRA','Chantier RA2',now()),('wRB','coRB','clRB','uRB','Chantier RB',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

/**
 * Barrière déterministe (même méthode que le lot C) : une transaction témoin tient le verrou consultatif du chantier ;
 * les deux opérations sont lancées et l'on CONSTATE qu'elles l'attendent (pg_blocking_pids, cliché vidé à chaque
 * observation) et qu'aucune n'est terminée, AVANT de lever la barrière. Barrière toujours levée (finally).
 */
async function underBarrier<T1, T2>(worksiteId: string, op1: () => Promise<T1>, op2: () => Promise<T2>): Promise<[T1, T2]> {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r })
  let locked!: () => void; const isLocked = new Promise<void>((r) => { locked = r })
  let witness!: Prisma.TransactionClient
  let holderPid = 0
  const key = `reception:${A.companyId}:${worksiteId}`
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
    holderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS pid`))[0].pid
    witness = tx; locked(); await gate
  }, { timeout: 30_000 })
  await isLocked
  const done: string[] = []
  const p1 = op1().finally(() => { done.push("op1") })
  const p2 = op2().finally(() => { done.push("op2") })
  let seen = { blocked: [] as number[], doneBeforeRelease: [] as string[] }
  let all: [PromiseSettledResult<void>, PromiseSettledResult<T1>, PromiseSettledResult<T2>] | undefined
  try {
    for (let i = 0; i < 100; i++) {
      await witness.$executeRawUnsafe(`SELECT pg_stat_clear_snapshot()`)
      const rows = await witness.$queryRawUnsafe<{ pid: number; bloqueurs: number[] }[]>(`SELECT pid, pg_blocking_pids(pid) AS bloqueurs FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`)
      const chain = new Set<number>([holderPid])
      for (let k = 0; k < rows.length; k++) for (const r of rows) if (!chain.has(r.pid) && r.bloqueurs.some((b) => chain.has(b))) chain.add(r.pid)
      chain.delete(holderPid)
      seen = { blocked: [...chain], doneBeforeRelease: [...done] }
      if (seen.blocked.length >= 2) break
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(holderPid > 0 && seen.blocked.length >= 2 && seen.doneBeforeRelease.length === 0, `les deux opérations attendent le verrou du chantier avant la levée (constaté : ${JSON.stringify(seen)})`)
  } finally {
    release()
    all = await Promise.allSettled([holder, p1, p2])
  }
  const [h, a, b] = all!
  if (h.status === "rejected") throw h.reason
  if (a.status === "rejected") throw a.reason
  if (b.status === "rejected") throw b.reason
  return [a.value, b.value]
}
async function snapshotMatchesLinks(reportId: string) {
  const links = await db.receptionReportReserve.count({ where: { reportId } })
  const p = (await getReportForPdf(db, A.companyId, reportId))!
  assert.equal(p.snapshot.reserves.length, links, "instantané et liens concordent")
  assert.ok(p.intact)
  return p
}

describe("réserves", () => {
  it("constat avec preuve PNG, responsable en libellé libre et échéance ; numérotation ; audit", async () => {
    r1 = ok(await svc.createReserve(db, A, { worksiteId: "wRA", title: "Éclat d'enduit", location: "R+1 chambre 2", severity: "MINOR", assigneeLabel: " Plaquiste (sous-traitant) ", dueDate: new Date("2026-11-20T00:00:00Z") }, [{ name: "photo.png", bytes: PNG }])).id
    r2 = ok(await svc.createReserve(db, A, { worksiteId: "wRA", title: "Joint silicone manquant", location: "Salle d'eau", severity: "MAJOR" })).id
    const r = await db.worksiteReserve.findUnique({ where: { id: r1 }, select: { number: true, status: true, assigneeLabel: true, files: { select: { kind: true, mime: true, size: true } } } })
    assert.match(r!.number, /^RES-\d{4}-0001$/, "numéro de l'année civile courante (Paris)")
    assert.deepEqual({ ...r, number: undefined }, { number: undefined, status: "OPEN", assigneeLabel: "Plaquiste (sous-traitant)", files: [{ kind: "FINDING", mime: "image/png", size: PNG.length }] })
    assert.equal(await db.historyLog.count({ where: { entityType: "WorksiteReserve", action: "CREATED", worksiteId: "wRA" } }), 2)
  })
  it("refus sans écriture : chantier d'une autre entreprise, responsable trop long, fichier déguisé, trop de fichiers", async () => {
    const before = [await db.worksiteReserve.count(), await db.historyLog.count(), await db.worksiteReserveFile.count()]
    const base = { title: "Fissure", location: "Façade", severity: "MINOR" }
    assert.deepEqual(await svc.createReserve(db, A, { ...base, worksiteId: "wRB" }), { ok: false, error: RESERVE_ERRORS.notFound })
    assert.deepEqual(await svc.createReserve(db, A, { ...base, worksiteId: "wRA", assigneeLabel: "x".repeat(121) }), { ok: false, error: RESERVE_ERRORS.assignee })
    assert.deepEqual(await svc.createReserve(db, A, { ...base, worksiteId: "wRA" }, [{ name: "photo.png", bytes: Buffer.from("<svg onload=x>") }]), { ok: false, error: RESERVE_ERRORS.file })
    assert.deepEqual(await svc.createReserve(db, A, { ...base, worksiteId: "wRA" }, Array.from({ length: 6 }, () => ({ name: "p.png", bytes: PNG }))), { ok: false, error: RESERVE_ERRORS.tooManyFiles })
    assert.deepEqual([await db.worksiteReserve.count(), await db.historyLog.count(), await db.worksiteReserveFile.count()], before)
  })
  it("base : libellé du responsable borné (CHECK) ; aucune table RH touchée", async () => {
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO worksite_reserves(id,"companyId","worksiteId",number,title,location,"assigneeLabel","createdById","updatedAt") VALUES ('rx','coRA','wRA','RX-1','Titre','Lieu','${"x".repeat(121)}','uRA',now())`), /worksite_reserves_values_check/)
    assert.equal(await db.employee.count({ where: { companyId: { in: ["coRA", "coRB"] } } }), 0, "aucun salarié requis ni créé")
  })
  it("preuve lisible par son entreprise seulement", async () => {
    const f = (await db.worksiteReserveFile.findFirst({ where: { reserveId: r1 }, select: { id: true } }))!
    assert.equal((await getReserveFile(db, "coRA", f.id))?.mime, "image/png")
    assert.equal(await getReserveFile(db, "coRB", f.id), null)
  })
})

describe("procès-verbal", () => {
  it("« sans réserves » refusé tant que des réserves sont ouvertes ; signature invalide refusée", async () => {
    assert.deepEqual(await svc.createReceptionReport(db, A, report({ decision: "WITHOUT_RESERVES" }), NOW), { ok: false, error: RESERVE_ERRORS.withoutReservesButOpen })
    assert.deepEqual(await svc.createReceptionReport(db, A, report({ signatureDataUrl: "data:image/png;base64,AAAA" }), NOW), { ok: false, error: RESERVE_ERRORS.signature })
    assert.equal(await db.receptionReport.count({ where: { companyId: "coRA" } }), 0)
  })
  it("« avec réserves » : inscrit TOUTES les réserves ouvertes, instantané figé et empreinte recalculable", async () => {
    const pv = ok(await svc.createReceptionReport(db, A, report(), NOW))
    assert.match(pv.number, /^PV-\d{4}-0001$/)
    const links = await db.receptionReportReserve.findMany({ where: { reportId: pv.id }, select: { reserveId: true } })
    assert.deepEqual(links.map((l) => l.reserveId).sort(), [r1, r2].sort())
    const forPdf = (await getReportForPdf(db, "coRA", pv.id))!
    assert.deepEqual([forPdf.intact, forPdf.snapshotIntact, forPdf.signatureIntact], [true, true, true], "empreintes recalculées depuis le JSON relu et les octets de signature")
    assert.deepEqual(forPdf.snapshot.reserves.map((r) => r.number.slice(-4)), ["0001", "0002"])
    assert.equal(forPdf.snapshot.reserves[0].assignee, "Plaquiste (sous-traitant)")
    assert.equal(forPdf.snapshot.company.name, "Entreprise RA")
    assert.equal(forPdf.snapshot.signatureSha256, sha256Hex(PNG))
    assert.ok(forPdf.signaturePng.equals(PNG))
    assert.equal(await getReportForPdf(db, "coRB", pv.id), null, "identifiant forgé d'une autre entreprise")
  })
  it("figé : renommer ensuite le chantier et le client ne change ni l'instantané ni son empreinte", async () => {
    const pv = (await db.receptionReport.findFirst({ where: { companyId: "coRA", worksiteId: "wRA" }, select: { id: true } }))!
    const before = (await getReportForPdf(db, "coRA", pv.id))!
    await db.$executeRawUnsafe(`UPDATE worksites SET name='Chantier RA renommé', address='99 rue Nouvelle' WHERE id='wRA'`)
    await db.$executeRawUnsafe(`UPDATE clients SET name='Client RA renommé' WHERE id='clRA'`)
    const afterChange = (await getReportForPdf(db, "coRA", pv.id))!
    assert.equal(snapshotSha256(afterChange.snapshot), snapshotSha256(before.snapshot))
    assert.deepEqual([afterChange.snapshot.worksite.name, afterChange.snapshot.worksite.client], ["Chantier RA", "Client RA"])
    assert.ok(afterChange.intact)
  })
  it("intégrité : altération isolée des octets de la signature, puis de l'instantané ⇒ intact faux (route 409)", async () => {
    await site("wRSIG")
    ok(await svc.createReserve(db, A, { worksiteId: "wRSIG", title: "Plinthe décollée", location: "Couloir", severity: "MINOR" }))
    const pv = ok(await svc.createReceptionReport(db, A, report({ worksiteId: "wRSIG" }), NOW))
    // Simulation d'une altération hors application : déclencheur d'immuabilité désactivé le temps d'une transaction (base jetable).
    const tamper = (set: string) => db.$transaction([
      db.$executeRawUnsafe(`ALTER TABLE reception_reports DISABLE TRIGGER reception_reports_immutable`),
      db.$executeRawUnsafe(`UPDATE reception_reports SET ${set} WHERE id='${pv.id}'`),
      db.$executeRawUnsafe(`ALTER TABLE reception_reports ENABLE TRIGGER reception_reports_immutable`),
    ])
    const other = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200, 2)])
    await tamper(`"signaturePng"='\\x${other.toString("hex")}'`)
    const sigAltered = (await getReportForPdf(db, "coRA", pv.id))!
    assert.deepEqual([sigAltered.snapshotIntact, sigAltered.signatureIntact, sigAltered.intact], [true, false, false], "seule la signature est altérée")
    await tamper(`"signaturePng"='\\x${PNG.toString("hex")}'`)
    assert.equal((await getReportForPdf(db, "coRA", pv.id))!.intact, true, "rétablie : intègre")
    await tamper(`snapshot = jsonb_set(snapshot, '{remarks}', '"ajout frauduleux"')`)
    const snapAltered = (await getReportForPdf(db, "coRA", pv.id))!
    assert.deepEqual([snapAltered.snapshotIntact, snapAltered.intact], [false, false])
    await assert.rejects(db.$executeRawUnsafe(`UPDATE reception_reports SET remarks='x' WHERE id='${pv.id}'`), /immutable/, "déclencheur bien réactivé")
    const route = readFileSync("src/app/(dashboard)/reserves/pv/[id]/pdf/route.tsx", "utf8")
    assert.match(route, /if \(!report\.intact\) \{[\s\S]*?return none\(409\)/, "la route refuse (409) avant tout rendu")
  })
  it("réserve inscrite : annulation refusée (service et base) ; levée admise avec preuve", async () => {
    assert.deepEqual(await svc.cancelReserve(db, A, r2, "Doublon", NOW), { ok: false, error: RESERVE_ERRORS.listedInReport })
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_reserves SET status='CANCELLED', "cancelledAt"=now(), "cancelledById"='uRA', "cancelReason"='Doublon' WHERE id='${r2}'`), /cannot be cancelled/)
    ok(await svc.liftReserve(db, A, r1, "Enduit repris et peint", [{ name: "apres.png", bytes: PNG }], NOW))
    assert.deepEqual(await svc.liftReserve(db, A, r1, "Encore", [], NOW), { ok: false, error: RESERVE_ERRORS.notOpen })
    assert.equal(await db.worksiteReserveFile.count({ where: { reserveId: r1, kind: "LIFT" } }), 1)
  })
  it("base : procès-verbal, liens et preuves immuables ; réserve jamais supprimée et figée une fois levée", async () => {
    const pv = (await db.receptionReport.findFirst({ where: { companyId: "coRA", worksiteId: "wRA" }, select: { id: true } }))!
    await assert.rejects(db.$executeRawUnsafe(`UPDATE reception_reports SET remarks='x' WHERE id='${pv.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM reception_reports WHERE id='${pv.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM reception_report_reserves WHERE "reportId"='${pv.id}'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE reception_report_reserves SET "reserveId"='${r1}' WHERE "reportId"='${pv.id}'`), /immutable/, "liaison non modifiable")
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_reserve_files SET "originalName"='x' WHERE "companyId"='coRA'`), /immutable/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM worksite_reserve_files WHERE "companyId"='coRA'`), /immutable/, "preuve non supprimable")
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM worksite_reserves WHERE id='${r2}'`), /cannot be deleted/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_reserves SET title='Autre titre' WHERE id='${r1}'`), /closed worksite reserve immutable/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE worksite_reserves SET "worksiteId"='wRA2' WHERE id='${r2}'`), /identity immutable/)
    await assert.rejects(db.$executeRawUnsafe(`TRUNCATE reception_report_reserves`), /immutable/)
  })
  it("base : un procès-verbal inséré hors service qui omet une réserve ouverte est refusé à la validation", async () => {
    await refusDiffere(
      (tx) => tx.$executeRawUnsafe(`INSERT INTO reception_reports(id,"companyId","worksiteId",number,decision,"receptionDate","clientSignerName","companySignerName","signatureSha256","signaturePng",snapshot,"snapshotSha256","createdById") VALUES ('pvx','coRA','wRA','PV-X','REFUSED','2026-11-04','M. Client','Mme C','${"a".repeat(64)}','\\x${PNG.toString("hex")}','{}','${"b".repeat(64)}','uRA')`),
      /every open reserve/,
      async () => (await db.receptionReport.count({ where: { id: "pvx" } })) === 0)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO reception_report_reserves(id,"companyId","reportId","reserveId") SELECT 'lx','coRA',id,'${r1}' FROM reception_reports WHERE "companyId"='coRA' LIMIT 1`), /immutable|open reserve of the same worksite/)
  })
})

describe("concurrence (barrière déterministe, verrou commun du chantier)", () => {
  it("création contre signature : la réserve est soit inscrite, soit postérieure au PV — jamais oubliée", async () => {
    await site("wRC1")
    const [pv, res] = await underBarrier("wRC1",
      () => svc.createReceptionReport(db, A, report({ worksiteId: "wRC1", decision: "REFUSED" }), NOW),
      () => svc.createReserve(db, A, { worksiteId: "wRC1", title: "Porte voilée", location: "Entrée", severity: "BLOCKING" }))
    const p = ok(pv), r = ok(res)
    const listed = await db.receptionReportReserve.count({ where: { reportId: p.id, reserveId: r.id } })
    const snap = await snapshotMatchesLinks(p.id)
    assert.equal(snap.snapshot.reserves.length, listed)
    if (listed === 0) assert.equal((await db.worksiteReserve.findUnique({ where: { id: r.id }, select: { status: true } }))!.status, "OPEN", "créée après la signature : reste ouverte, non inscrite")
  })
  it("annulation contre signature : jamais « annulée ET inscrite »", async () => {
    await site("wRC2")
    const id = ok(await svc.createReserve(db, A, { worksiteId: "wRC2", title: "Réserve à annuler", location: "Pièce", severity: "MINOR" })).id
    const [pv, cancel] = await underBarrier("wRC2",
      () => svc.createReceptionReport(db, A, report({ worksiteId: "wRC2", decision: "REFUSED" }), NOW),
      () => svc.cancelReserve(db, A, id, "Saisie en double", NOW))
    const p = ok(pv)
    const r = (await db.worksiteReserve.findUnique({ where: { id }, select: { status: true, _count: { select: { reports: true } } } }))!
    assert.ok(!(r.status === "CANCELLED" && r._count.reports > 0), "réserve annulée et inscrite")
    if (cancel.ok) assert.deepEqual([r.status, r._count.reports], ["CANCELLED", 0])
    else { assert.deepEqual(cancel, { ok: false, error: RESERVE_ERRORS.listedInReport }); assert.deepEqual([r.status, r._count.reports], ["OPEN", 1]) }
    await snapshotMatchesLinks(p.id)
  })
  it("levée contre signature : levée toujours admise ; inscrite seulement si encore ouverte à la signature ; instantané cohérent", async () => {
    await site("wRC3")
    const id = ok(await svc.createReserve(db, A, { worksiteId: "wRC3", title: "Réserve à lever", location: "Pièce", severity: "MAJOR" })).id
    const [pv, lift] = await underBarrier("wRC3",
      () => svc.createReceptionReport(db, A, report({ worksiteId: "wRC3", decision: "REFUSED" }), NOW),
      () => svc.liftReserve(db, A, id, "Reprise effectuée", [], NOW))
    const p = ok(pv); ok(lift)
    const r = (await db.worksiteReserve.findUnique({ where: { id }, select: { status: true, _count: { select: { reports: true } } } }))!
    assert.equal(r.status, "LIFTED")
    const snap = await snapshotMatchesLinks(p.id)
    assert.equal(snap.snapshot.reserves.length, r._count.reports, "inscrite (signature d'abord) ou absente (levée d'abord), jamais un état mixte")
  })
})

describe("plafond du procès-verbal (500)", () => {
  const bulk = (worksiteId: string, n: number, prefix: string) => db.$executeRawUnsafe(
    `INSERT INTO worksite_reserves(id,"companyId","worksiteId",number,title,location,"createdById","updatedAt") SELECT '${prefix}-'||g,'coRA','${worksiteId}','${prefix}-'||lpad(g::text,4,'0'),'Réserve '||g,'Pièce '||g,'uRA',now() FROM generate_series(1,${n}) g`)
  it("500 réserves ouvertes : PV complet, 500 liens et instantané exhaustif", async () => {
    await site("wR500"); await bulk("wR500", MAX_REPORT_RESERVES, "B500")
    const pv = ok(await svc.createReceptionReport(db, A, report({ worksiteId: "wR500" }), NOW))
    assert.equal(await db.receptionReportReserve.count({ where: { reportId: pv.id } }), 500)
    const p = (await getReportForPdf(db, "coRA", pv.id))!
    assert.equal(p.snapshot.reserves.length, 500)
    assert.equal(p.snapshot.reserves[499].number, "B500-0500", "dernière réserve présente : aucune troncature")
    assert.ok(p.intact)
  })
  it("501 réserves ouvertes : refus explicite AVANT toute écriture (aucun PV, aucun numéro consommé, aucun audit)", async () => {
    await site("wR501"); await bulk("wR501", MAX_REPORT_RESERVES + 1, "B501")
    const counter = () => db.documentCounter.findMany({ where: { companyId: "coRA", type: "RECEPTION_REPORT" }, select: { lastValue: true } })
    const before = [await db.receptionReport.count(), await db.historyLog.count({ where: { entityType: "ReceptionReport" } }), JSON.stringify(await counter())]
    assert.deepEqual(await svc.createReceptionReport(db, A, report({ worksiteId: "wR501" }), NOW), { ok: false, error: RESERVE_ERRORS.tooManyReserves })
    assert.deepEqual([await db.receptionReport.count(), await db.historyLog.count({ where: { entityType: "ReceptionReport" } }), JSON.stringify(await counter())], before)
    const page = (await getWorksiteReception(db, "coRA", "wR501"))!
    assert.deepEqual([page.openCount, page.reserves.length, page.truncated], [501, 500, true], "liste affichée plafonnée et signalée ; décompte exact")
  })
  it("base : un PV forgé inscrivant plus de 500 réserves est refusé à la validation (défense en profondeur)", async () => {
    await refusDiffere(
      async (tx) => {
        await tx.$executeRawUnsafe(`INSERT INTO reception_reports(id,"companyId","worksiteId",number,decision,"receptionDate","clientSignerName","companySignerName","signatureSha256","signaturePng",snapshot,"snapshotSha256","createdById") VALUES ('pv501','coRA','wR501','PV-501','WITH_RESERVES','2026-11-04','M. Client','Mme C','${"a".repeat(64)}','\\x${PNG.toString("hex")}','{}','${"b".repeat(64)}','uRA')`)
        await tx.$executeRawUnsafe(`INSERT INTO reception_report_reserves(id,"companyId","reportId","reserveId") SELECT 'l501-'||id,'coRA','pv501',id FROM worksite_reserves WHERE "worksiteId"='wR501'`)
      },
      /more than 500 reserves/,
      async () => (await db.receptionReport.count({ where: { id: "pv501" } })) === 0 && (await db.receptionReportReserve.count({ where: { reportId: "pv501" } })) === 0)
  })
})

describe("isolation et suppression de chantier (E10)", () => {
  it("le chantier de l'entreprise B ne voit rien de A", async () => {
    assert.equal(await getWorksiteReception(db, "coRB", "wRA"), null)
    const b = await getWorksiteReception(db, "coRB", "wRB")
    assert.deepEqual([b!.reserves.length, b!.reports.length, b!.openCount], [0, 0, 0])
    assert.deepEqual(await svc.liftReserve(db, B, r2, "Tentative", [], NOW), { ok: false, error: RESERVE_ERRORS.notFound })
    assert.deepEqual(await svc.cancelReserve(db, B, r2, "Tentative", NOW), { ok: false, error: RESERVE_ERRORS.notFound })
    assert.deepEqual(await svc.createReceptionReport(db, B, report({ worksiteId: "wRA" }), NOW), { ok: false, error: RESERVE_ERRORS.notFound })
  })
  it("chantier portant une réserve : suppression refusée par la clé RESTRICT (P2003) ; chantier sans réserve : supprimable", async () => {
    await site("wRDEL1"); await site("wRDEL2")
    ok(await svc.createReserve(db, A, { worksiteId: "wRDEL1", title: "Réserve bloquante", location: "Lieu", severity: "MINOR" }))
    await assert.rejects(db.worksite.delete({ where: { id: "wRDEL1" } }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003")
    assert.equal(await db.worksite.count({ where: { id: "wRDEL1" } }), 1, "aucune suppression")
    await db.worksite.delete({ where: { id: "wRDEL2" } })
    assert.equal(await db.worksite.count({ where: { id: "wRDEL2" } }), 0, "comportement inchangé sans réserve")
    // Action Chantiers (non modifiée par le lot D) : le P2003 y est déjà rendu en refus. Libellé hérité imprécis (« factures »)
    // quand une réserve ou un PV bloque : réserve d'ergonomie documentée, hors périmètre.
    const action = readFileSync("src/lib/actions/chantier.actions.ts", "utf8")
    assert.match(action, /\(error as \{ code\?: string \}\)\.code === "P2003"\) \{\n\s+return \{ error: "Ce chantier a des factures : il ne peut pas être supprimé\. Archivez-le plutôt\." \}/)
  })
})
