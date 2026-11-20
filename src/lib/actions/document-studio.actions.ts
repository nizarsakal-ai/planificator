"use server"
// Lot G Planificator V2 : actions serveur du Document Studio (ADMIN de la société de session, drapeau
// DOCUMENT_STUDIO_ENABLED). Aucun identifiant d'entreprise n'est lu du formulaire.
// Portage sur ef36578f (19/11/2026) : retour EXPLICITE par état (RetourAction, mécanisme qualifié E4) au lieu de
// revalidatePath + redirection serveur. Le client (FormulaireRetour) ouvre ensuite, par une navigation native du document,
// la cible CALCULÉE ICI (fiche du modèle créé, document généré) ou rouvre la page courante ; les adresses sont limitées par
// la liste blanche de retour-action.ts. Seule redirection serveur conservée : /login si la session est absente.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { StudioAccessError, requireStudioAdmin, studioAccessMessage, type StudioAccessContext } from "@/lib/document-studio/access"
import { STUDIO_ERRORS, parseFieldLines } from "@/lib/document-studio/studio.core"
import { STUDIO_SIGNATURE_MAX_CHARS } from "@/lib/document-studio/signature"
import * as svc from "@/lib/document-studio/studio.service"
import * as pdfSvc from "@/lib/document-studio/pdf-workspace.service"
import { PDF_ERRORS, PDF_LIMITS } from "@/lib/document-studio/pdf-workspace.core"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const BASE = "/studio-documents"
const str = (f: FormData, k: string, max = 500) => String(f.get(k) ?? "").slice(0, max)
const reqId = (f: FormData, k: string) => { const v = str(f, k, 64).trim(); return v && ID.test(v) ? v : "" }
type Outcome = { ok: true; okMessage: string; cible?: string } | { ok: false; error: string }
/** Cibles calculées côté serveur à partir d'identifiants issus de la base (jamais du formulaire). */
const ficheModele = (templateId: string) => `${BASE}/${templateId}`
const ficheDocument = (documentId: string) => `${BASE}/documents/${documentId}`
const fichePdf = (pdfId: string) => `${BASE}/fichiers/${pdfId}`

async function run(fn: (ctx: StudioAccessContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireStudioAdmin())
  } catch (e) {
    if (e instanceof StudioAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof StudioAccessError) return retour(false, studioAccessMessage(e.reason))
    console.error("[studio] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage, result.cible) : retour(false, result.error)
}
function content(form: FormData) {
  const fields = parseFieldLines(str(form, "fields", 20_000))
  return { title: str(form, "title", 1000), body: str(form, "body", 25_000), fields: fields ?? "invalide", requiresApproval: str(form, "requiresApproval", 5) === "oui" }
}

export async function createTemplateAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const c = content(form)
    if (c.fields === "invalide") return { ok: false, error: STUDIO_ERRORS.fields }
    const r = await svc.createTemplate(prisma, ctx, { name: str(form, "name", 1000), category: str(form, "category", 20), ...c })
    return r.ok ? { ok: true, okMessage: "Modèle créé : version 1 en brouillon.", cible: ficheModele(r.value.templateId) } : r
  })
}
export async function updateDraftAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const c = content(form)
    if (c.fields === "invalide") return { ok: false, error: STUDIO_ERRORS.fields }
    const r = await svc.updateDraft(prisma, ctx, reqId(form, "versionId"), c)
    return r.ok ? { ok: true, okMessage: "Brouillon enregistré." } : r
  })
}
export async function createDraftAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.createDraft(prisma, ctx, reqId(form, "templateId"))
    return r.ok ? { ok: true, okMessage: "Nouveau brouillon créé depuis la dernière version." } : r
  })
}
export async function publishVersionAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de publication." }
    const r = await svc.publishVersion(prisma, ctx, reqId(form, "versionId"))
    return r.ok ? { ok: true, okMessage: "Version publiée : elle est désormais figée." } : r
  })
}
export async function generateDocumentAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const values: Record<string, string> = {}
    for (const [k, v] of form.entries()) if (k.startsWith("f_") && typeof v === "string") values[k.slice(2)] = v.slice(0, 5000)
    const r = await svc.generateDocument(prisma, ctx, reqId(form, "templateId"), { values, clientId: reqId(form, "clientId") || null, worksiteId: reqId(form, "worksiteId") || null })
    return r.ok ? { ok: true, okMessage: r.value.status === "ISSUED" ? `Document ${r.value.number} émis.` : `Document ${r.value.number} créé : en attente de validation par un autre administrateur.`, cible: ficheDocument(r.value.id) } : r
  })
}
export async function approveDocumentAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (str(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation de validation." }
    const r = await svc.approveDocument(prisma, ctx, reqId(form, "documentId"), { signerName: str(form, "signerName", 1000), signature: str(form, "signature", STUDIO_SIGNATURE_MAX_CHARS + 1) })
    return r.ok ? { ok: true, okMessage: "Document validé et signé." } : r
  })
}
export async function rejectDocumentAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await svc.rejectDocument(prisma, ctx, reqId(form, "documentId"), str(form, "reason", 1000))
    return r.ok ? { ok: true, okMessage: "Document refusé." } : r
  })
}

// ── Espace PDF (lots 1 et 2) ─────────────────────────────────────────────────────────────────────────────────────────

/** Lot 1 : import d'un PDF reçu. Le fichier est lu en mémoire après contrôle de sa taille déclarée. */
export async function importPdfAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const file = form.get("file")
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: PDF_ERRORS.noFile }
    if (file.size > PDF_LIMITS.maxUploadBytes) return { ok: false, error: PDF_ERRORS.tooLarge }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await pdfSvc.importPdf(prisma, ctx, { title: str(form, "title", 1000), originalName: file.name, bytes })
    if (!r.ok) return r
    return { ok: true, okMessage: r.value.duplicate ? "Ce PDF était déjà importé : voici sa fiche." : "PDF importé.", cible: fichePdf(r.value.pdfId) }
  })
}

/** Lot 2 : remplir et signer — nouvelle version construite depuis la dernière. */
export async function fillSignPdfAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const pdfId = reqId(form, "pdfId")
    if (!pdfId) return { ok: false, error: PDF_ERRORS.notFound }
    const r = await pdfSvc.fillAndSignPdf(prisma, ctx, pdfId, {
      baseRevisionId: reqId(form, "baseRevisionId"),
      operations: str(form, "operations", 200_000),
      signerName: str(form, "signerName", 1000),
      signature: str(form, "signature", STUDIO_SIGNATURE_MAX_CHARS + 1),
    })
    return r.ok ? { ok: true, okMessage: `Version ${r.value.revision} enregistrée.`, cible: fichePdf(pdfId) } : r
  })
}
