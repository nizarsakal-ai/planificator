/**
 * Lot G Planificator V2 : service du Document Studio. Toute lecture et écriture est bornée par `ctx.companyId`
 * (session) ; chaque écriture est auditée (HistoryLog) dans sa transaction.
 *
 * - Modèle : nom unique par entreprise ; créé avec une version 1 en brouillon.
 * - Brouillon : seul état modifiable ; un seul brouillon par modèle (garanti aussi en base).
 * - Publication : verrou du modèle (`FOR UPDATE`), contenu revalidé, version précédente retirée, empreinte fixée ; la
 *   version publiée est ensuite immuable (garanti en base).
 * - Génération : la version publiée est verrouillée en partage (`FOR SHARE`) pour qu'une publication concurrente ne la
 *   retire pas pendant la génération ; valeurs validées (inconnues et obligatoires manquantes refusées) ; instantané
 *   rendu, figé et empreint ; état « en attente de validation » si la version l'exige, sinon « émis ».
 * - Validation : par un AUTRE administrateur que l'auteur, avec signature manuscrite (analyseur local au lot G : PNG
 *   borné, empreinte SHA-256, mêmes règles que la v6) ; refus motivé. Décision unique (garanti en base).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { businessYear } from "@/lib/billing/business-day"
import { serverNow } from "@/lib/billing/clock"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { parseStudioSignature } from "@/lib/document-studio/signature"
import {
  STUDIO_ERRORS, documentSha256, readFields, renderDocument, validateReason, validateSignerName, validateTemplateIdentity,
  validateValues, validateVersionContent, versionSha256, type VersionContent,
} from "@/lib/document-studio/studio.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface StudioContext { companyId: string; userId: string }
export type StudioResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }
export interface ContentInput { title: string; body: string; fields: unknown; requiresApproval: boolean }

class StudioFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "StudioFailure" }
}
const fail = (m: string): never => { throw new StudioFailure(m) }
function must<T>(p: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!p.ok) fail(p.error)
  return (p as { ok: true; value: T }).value
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<StudioResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof StudioFailure) return { ok: false, error: e.userMessage }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = String((e.meta as { target?: unknown } | undefined)?.target ?? "")
      // Revue indépendante : message juste pour chaque unicité (nom, brouillon unique), « modifié entre-temps » sinon.
      return { ok: false, error: target.includes("name") ? STUDIO_ERRORS.duplicateName : target.includes("one_draft") ? STUDIO_ERRORS.draftExists : STUDIO_ERRORS.changedMeanwhile }
    }
    throw e
  }
}
async function audit(tx: Tx, ctx: StudioContext, a: { action: "CREATED" | "UPDATED" | "STATUS_CHANGED"; entityType: string; entityId: string; detail: string; worksiteId?: string | null }) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId ?? null, action: a.action, entityType: a.entityType, entityId: a.entityId, detail: a.detail.slice(0, 1000) } })
}
const contentData = (c: VersionContent) => ({ title: c.title, body: c.body, fields: c.fields.map((f) => ({ ...f })), requiresApproval: c.requiresApproval })

export async function createTemplate(db: Db, ctx: StudioContext, input: { name: string; category: string } & ContentInput): Promise<StudioResult<{ templateId: string; versionId: string }>> {
  const id = validateTemplateIdentity(input)
  if (!id.ok) return id
  const c = validateVersionContent(input)
  if (!c.ok) return c
  return inTx(db, async (tx) => {
    const t = await tx.documentTemplate.create({ data: { companyId: ctx.companyId, name: id.value.name, category: id.value.category, createdById: ctx.userId }, select: { id: true } })
    const v = await tx.documentTemplateVersion.create({ data: { companyId: ctx.companyId, templateId: t.id, version: 1, ...contentData(c.value), createdById: ctx.userId }, select: { id: true } })
    await audit(tx, ctx, { action: "CREATED", entityType: "DocumentTemplate", entityId: t.id, detail: `Modèle « ${id.value.name} » créé (version 1 en brouillon)` })
    return { templateId: t.id, versionId: v.id }
  })
}

async function lockTemplate(tx: Tx, ctx: StudioContext, templateId: string) {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT "id", "name" FROM "document_templates" WHERE "id" = ${templateId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  return rows[0] ?? fail(STUDIO_ERRORS.notFound)
}
async function draftOf(tx: Tx, ctx: StudioContext, versionId: string) {
  const v = (await tx.documentTemplateVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, select: { id: true, templateId: true, version: true, status: true } })) ?? fail(STUDIO_ERRORS.notFound)
  return v
}

export async function updateDraft(db: Db, ctx: StudioContext, versionId: string, input: ContentInput): Promise<StudioResult> {
  const c = validateVersionContent(input)
  if (!c.ok) return c
  return inTx(db, async (tx) => {
    const v0 = await draftOf(tx, ctx, versionId)
    const t = await lockTemplate(tx, ctx, v0.templateId)
    const u = await tx.documentTemplateVersion.updateMany({ where: { id: versionId, companyId: ctx.companyId, status: "DRAFT" }, data: contentData(c.value) })
    if (u.count !== 1) fail(STUDIO_ERRORS.notDraft)
    await audit(tx, ctx, { action: "UPDATED", entityType: "DocumentTemplate", entityId: t.id, detail: `Modèle « ${t.name} » : brouillon v${v0.version} modifié` })
    return undefined
  })
}

/** Nouveau brouillon, copié de la dernière version (publiée ou retirée). */
export async function createDraft(db: Db, ctx: StudioContext, templateId: string): Promise<StudioResult<{ versionId: string }>> {
  return inTx(db, async (tx) => {
    const t = await lockTemplate(tx, ctx, templateId)
    if (await tx.documentTemplateVersion.findFirst({ where: { templateId, companyId: ctx.companyId, status: "DRAFT" }, select: { id: true } })) fail(STUDIO_ERRORS.draftExists)
    const last = (await tx.documentTemplateVersion.findFirst({ where: { templateId, companyId: ctx.companyId }, orderBy: { version: "desc" }, select: { version: true, title: true, body: true, fields: true, requiresApproval: true } })) ?? fail(STUDIO_ERRORS.notFound)
    const v = await tx.documentTemplateVersion.create({
      data: { companyId: ctx.companyId, templateId, version: last.version + 1, title: last.title, body: last.body, fields: (last.fields ?? []) as Prisma.InputJsonValue, requiresApproval: last.requiresApproval, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "DocumentTemplate", entityId: t.id, detail: `Modèle « ${t.name} » : brouillon v${last.version + 1} créé` })
    return { versionId: v.id }
  })
}

export async function publishVersion(db: Db, ctx: StudioContext, versionId: string, now: Date = serverNow()): Promise<StudioResult<{ sha256: string }>> {
  return inTx(db, async (tx) => {
    const v0 = await draftOf(tx, ctx, versionId)
    const t = await lockTemplate(tx, ctx, v0.templateId)
    const v = (await tx.documentTemplateVersion.findFirst({ where: { id: versionId, companyId: ctx.companyId }, select: { status: true, version: true, title: true, body: true, fields: true, requiresApproval: true } })) ?? fail(STUDIO_ERRORS.notFound)
    if (v.status !== "DRAFT") fail(STUDIO_ERRORS.notDraft)
    const c = must(validateVersionContent({ title: v.title, body: v.body, fields: v.fields, requiresApproval: v.requiresApproval }))
    const sha = versionSha256(c)
    await tx.documentTemplateVersion.updateMany({ where: { templateId: t.id, companyId: ctx.companyId, status: "PUBLISHED" }, data: { status: "RETIRED", retiredAt: now } })
    const u = await tx.documentTemplateVersion.updateMany({ where: { id: versionId, companyId: ctx.companyId, status: "DRAFT" }, data: { status: "PUBLISHED", contentSha256: sha, publishedById: ctx.userId, publishedAt: now } })
    if (u.count !== 1) fail(STUDIO_ERRORS.notDraft)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "DocumentTemplate", entityId: t.id, detail: `Modèle « ${t.name} » : version ${v.version} publiée (${sha.slice(0, 12)})` })
    return { sha256: sha }
  })
}

async function nextNumber(tx: Tx, companyId: string, now: Date): Promise<string> {
  const year = businessYear(now)
  const c = await tx.documentCounter.upsert({
    where: { companyId_type_year: { companyId, type: "GENERATED_DOCUMENT", year } },
    create: { companyId, type: "GENERATED_DOCUMENT", year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `DOC-${year}-${String(c.lastValue).padStart(4, "0")}`
}

export interface GenerateInput { values: Record<string, string>; clientId?: string | null; worksiteId?: string | null }

export async function generateDocument(db: Db, ctx: StudioContext, templateId: string, input: GenerateInput, now: Date = serverNow()): Promise<StudioResult<{ id: string; number: string; status: "PENDING_APPROVAL" | "ISSUED" }>> {
  return inTx(db, async (tx) => {
    const t = (await tx.documentTemplate.findFirst({ where: { id: templateId, companyId: ctx.companyId }, select: { id: true, name: true } })) ?? fail(STUDIO_ERRORS.notFound)
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "document_template_versions" WHERE "templateId" = ${t.id} AND "companyId" = ${ctx.companyId} AND "status" = 'PUBLISHED' FOR SHARE`
    if (rows.length !== 1) fail(STUDIO_ERRORS.noPublished)
    const v = (await tx.documentTemplateVersion.findFirst({ where: { id: rows[0].id, companyId: ctx.companyId }, select: { id: true, version: true, title: true, body: true, fields: true, requiresApproval: true, contentSha256: true } })) ?? fail(STUDIO_ERRORS.noPublished)
    const fields = readFields(v.fields) ?? fail(STUDIO_ERRORS.notFound)
    const values = must(validateValues(fields, input.values))
    const client = input.clientId ? (await tx.client.findFirst({ where: { id: input.clientId, companyId: ctx.companyId }, select: { id: true, name: true } })) ?? fail(STUDIO_ERRORS.notFound) : null
    const worksite = input.worksiteId ? (await tx.worksite.findFirst({ where: { id: input.worksiteId, companyId: ctx.companyId }, select: { id: true, name: true } })) ?? fail(STUDIO_ERRORS.notFound) : null
    const company = (await tx.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } })) ?? fail(STUDIO_ERRORS.notFound)
    const number = await nextNumber(tx, ctx.companyId, now)
    const content: VersionContent = { title: v.title, body: v.body, fields, requiresApproval: v.requiresApproval }
    const snapshot = renderDocument(content, values, { entreprise: company.name, numero: number, date_document: formatDay(parisToday(now)), client: client?.name ?? null, chantier: worksite?.name ?? null }, { templateName: t.name, version: v.version, versionSha256: v.contentSha256 ?? "" })
    const status = v.requiresApproval ? "PENDING_APPROVAL" as const : "ISSUED" as const
    const d = await tx.generatedDocument.create({
      data: {
        companyId: ctx.companyId, versionId: v.id, number, title: snapshot.title.slice(0, 200), values, snapshot: snapshot as unknown as Prisma.InputJsonObject,
        snapshotSha256: documentSha256(snapshot), status, clientId: client?.id ?? null, worksiteId: worksite?.id ?? null, createdById: ctx.userId,
      },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "GeneratedDocument", entityId: d.id, worksiteId: worksite?.id ?? null, detail: `Document ${number} généré depuis « ${t.name} » v${v.version}${status === "PENDING_APPROVAL" ? " (en attente de validation)" : ""}` })
    return { id: d.id, number, status }
  })
}

async function lockPending(tx: Tx, ctx: StudioContext, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "generated_documents" WHERE "id" = ${id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(STUDIO_ERRORS.notFound)
  const d = (await tx.generatedDocument.findFirst({ where: { id, companyId: ctx.companyId }, select: { id: true, number: true, status: true, createdById: true, worksiteId: true } })) ?? fail(STUDIO_ERRORS.notFound)
  if (d.status !== "PENDING_APPROVAL") fail(STUDIO_ERRORS.notPending)
  return d
}

export async function approveDocument(db: Db, ctx: StudioContext, id: string, input: { signerName: string; signature: string }, now: Date = serverNow()): Promise<StudioResult> {
  const n = validateSignerName(input.signerName)
  if (!n.ok) return n
  const sig = parseStudioSignature(input.signature)
  if (!sig.ok) return sig
  return inTx(db, async (tx) => {
    const d = await lockPending(tx, ctx, id)
    if (d.createdById === ctx.userId) fail(STUDIO_ERRORS.selfApproval)
    await tx.generatedDocument.update({ where: { id: d.id }, data: { status: "ISSUED", approvedById: ctx.userId, approvedAt: now, signerName: n.value, signaturePng: sig.value.png, signatureSha256: sig.value.sha256 } })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "GeneratedDocument", entityId: d.id, worksiteId: d.worksiteId, detail: `Document ${d.number} validé et signé par ${n.value}` })
    return undefined
  })
}

export async function rejectDocument(db: Db, ctx: StudioContext, id: string, reason: string, now: Date = serverNow()): Promise<StudioResult> {
  const r = validateReason(reason)
  if (!r.ok) return r
  return inTx(db, async (tx) => {
    const d = await lockPending(tx, ctx, id)
    // Revue indépendante : circuit à quatre yeux dans les deux sens, l'auteur ne refuse pas non plus son document.
    if (d.createdById === ctx.userId) fail(STUDIO_ERRORS.selfApproval)
    await tx.generatedDocument.update({ where: { id: d.id }, data: { status: "REJECTED", rejectedById: ctx.userId, rejectedAt: now, rejectReason: r.value } })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "GeneratedDocument", entityId: d.id, worksiteId: d.worksiteId, detail: `Document ${d.number} refusé : ${r.value}` })
    return undefined
  })
}
