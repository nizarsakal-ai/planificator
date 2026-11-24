// Lot G Planificator V2 : Document Studio — modèles (versions, publication) et documents générés. Les PDF existants du
// logiciel ne sont pas modifiés. Drapeau DOCUMENT_STUDIO_ENABLED + ADMIN/SUPER_ADMIN.
// Portage sur ef36578f : refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour,
// MessageRetour, FormulaireRetour), liens HTML natifs vers les écrans du module (navigation du document).
// Accueil-v3 : accueil « par outils » (recherche, trois groupes, rail « Accès rapides »), composition propre à Planificator.
// Vues de choix bornées (?vue=generer|validation|pdf, une seule valeur) au-dessus des listes complètes, toujours présentes ;
// sections à ancres stables : #outils, #nouveau-modele, #modeles, #documents, #generer, #validation, #pdf.
// Espace PDF (lots 1 et 2, 20/11/2026) : #importer (dépôt d'un PDF reçu) et #fichiers (PDF importés, vers leur fiche).
// Lot 3 : #combiner (plusieurs PDF importés en un nouveau PDF ; les PDF chiffrés ne sont pas proposés).
// Lot G2 : éditeur visuel avec aperçu pour la création, modèles de départ (?depart=, liste fermée, rien n'est créé avant
// l'envoi), recherche dans les documents générés (?q=, ?etat=, relus et bornés ici, filtrés dans la requête).
import { FilePenLine } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { studioPageAccess } from "@/lib/document-studio/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/document-studio/studio.core"
import { STARTERS, lireDepart } from "@/lib/document-studio/starters"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { listGeneratedDocuments, listPdfDocuments, listPendingDocuments, listPublishedTemplates, listTemplates } from "@/lib/document-studio/queries"
import { lireRecherche, lireVue } from "@/lib/document-studio/tool-hub"
import { createTemplateAction, importPdfAction } from "@/lib/actions/document-studio.actions"
import { listStudioPdfs } from "@/lib/document-studio/pdf-workspace.queries"
import { PDF_UPLOAD_LABEL } from "@/lib/document-studio/pdf-workspace.core"
import { StudioPdfCombiner } from "@/components/document-studio/StudioPdfCombiner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"
import { DOC_STATUS_CLASS, DOC_STATUS_LABEL, VERSION_STATUS_LABEL } from "@/components/document-studio/labels"
import { StudioToolHub } from "@/components/document-studio/StudioToolHub"
import { StudioTemplateEditor } from "@/components/document-studio/StudioTemplateEditor"
import { StudioDocumentSearch } from "@/components/document-studio/StudioDocumentSearch"

const LIEN = "text-[#0f3460] underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] rounded-sm"
const ACCES_RAPIDES = [
  { href: "/studio-documents#outils", label: "Outils" },
  { href: "/studio-documents#nouveau-modele", label: "Nouveau modèle" },
  { href: "/studio-documents#modeles", label: "Modèles et versions" },
  { href: "/studio-documents#documents", label: "Documents générés" },
  { href: "/studio-documents?vue=validation#validation", label: "En attente de validation" },
  { href: "/studio-documents?vue=pdf#pdf", label: "Télécharger un PDF" },
  { href: "/studio-documents#importer", label: "Importer un PDF" },
  { href: "/studio-documents#fichiers", label: "PDF importés" },
  { href: "/studio-documents#combiner", label: "Combiner des PDF" },
] as const

export default async function StudioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await studioPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const vue = lireVue(params.vue)
  const recherche = lireRecherche(params.q, params.etat)
  const depart = lireDepart(params.depart)
  const [templates, docs, company, fichiers] = await Promise.all([
    listTemplates(prisma, ctx.companyId),
    listGeneratedDocuments(prisma, ctx.companyId, 50, { q: recherche.q, status: recherche.etat }),
    prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } }),
    listStudioPdfs(prisma, ctx.companyId),
  ])
  const filtre = recherche.q !== "" || recherche.etat !== null
  const publies = vue === "generer" ? await listPublishedTemplates(prisma, ctx.companyId) : []
  const enAttente = vue === "validation" ? await listPendingDocuments(prisma, ctx.companyId) : []
  const pdfs = vue === "pdf" ? await listPdfDocuments(prisma, ctx.companyId) : []

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><FilePenLine aria-hidden="true" className="h-6 w-6 text-[#0f3460]" /> Document Studio</h1>
        <p className="mt-1 text-sm text-slate-600">Modèles versionnés · version publiée figée · génération reproductible · validation par un second administrateur avec signature</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <section id="outils" aria-label="Outils du Document Studio" className="min-w-0 scroll-mt-4">
          <StudioToolHub />
        </section>
        <nav aria-labelledby="acces-rapides-titre" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:sticky lg:top-4">
          <h2 id="acces-rapides-titre" className="border-b border-slate-300 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">Accès rapides</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {ACCES_RAPIDES.map((l) => <li key={l.href}><a href={l.href} className={LIEN}>{l.label}</a></li>)}
          </ul>
        </nav>
      </div>

      {vue === "generer" && (
        <section id="generer" aria-labelledby="generer-titre" className="scroll-mt-4">
          <Card><CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="generer-titre" className="text-sm font-semibold text-slate-900">Générer un document : choisir un modèle publié</h2>
              <a href="/studio-documents#modeles" className={`text-xs ${LIEN}`}>Retour aux listes complètes</a>
            </div>
            {publies.length === 0 ? (
              <p className="text-sm text-slate-600">Aucun modèle publié. Publiez une version depuis la fiche d&apos;un modèle, ou <a href="/studio-documents#nouveau-modele" className={LIEN}>créez un modèle</a>.</p>
            ) : (
              <ul className="divide-y divide-slate-200 text-sm">
                {publies.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0"><span className="font-medium text-slate-800">{t.name}</span> <span className="text-xs text-slate-600">· {CATEGORY_LABEL[t.category as Category] ?? t.category}{t.versions[0] ? ` · v${t.versions[0].version}${t.versions[0].requiresApproval ? " · validation requise" : ""}` : ""}</span></span>
                    <a href={`/studio-documents/${t.id}#generer`} className={`text-sm font-medium ${LIEN}`}>Remplir et générer</a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </section>
      )}

      {vue === "validation" && (
        <section id="validation" aria-labelledby="validation-titre" className="scroll-mt-4">
          <Card><CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="validation-titre" className="text-sm font-semibold text-slate-900">En attente de validation</h2>
              <a href="/studio-documents#documents" className={`text-xs ${LIEN}`}>Retour aux listes complètes</a>
            </div>
            <p className="text-xs text-slate-600">La validation signée ou le refus motivé revient à un autre administrateur que l&apos;auteur du document.</p>
            {enAttente.length === 0 ? (
              <p className="text-sm text-slate-600">Aucun document en attente de validation.</p>
            ) : (
              <ul className="divide-y divide-slate-200 text-sm">
                {enAttente.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0"><span className="font-mono text-xs text-slate-700">{d.number}</span> <span className="text-slate-800">{d.title}</span> <span className="text-xs text-slate-600">({d.version.template.name} v{d.version.version}) · créé le {fmtInstant(d.createdAt)}</span></span>
                    {d.createdById === ctx.userId
                      ? <span className="text-xs text-slate-600">Vous en êtes l&apos;auteur : <a href={`/studio-documents/documents/${d.id}`} className={LIEN}>consulter</a></span>
                      : <a href={`/studio-documents/documents/${d.id}`} className={`text-sm font-medium ${LIEN}`}>Valider ou refuser</a>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </section>
      )}

      {vue === "pdf" && (
        <section id="pdf" aria-labelledby="pdf-titre" className="scroll-mt-4">
          <Card><CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="pdf-titre" className="text-sm font-semibold text-slate-900">Télécharger un PDF : choisir un document</h2>
              <a href="/studio-documents#documents" className={`text-xs ${LIEN}`}>Retour aux listes complètes</a>
            </div>
            <p className="text-xs text-slate-600">Le PDF est reconstruit depuis le contenu figé du document ; un projet en attente ou un document refusé porte sa mention.</p>
            {pdfs.length === 0 ? (
              <p className="text-sm text-slate-600">Aucun document généré.</p>
            ) : (
              <ul className="divide-y divide-slate-200 text-sm">
                {pdfs.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0"><a href={`/studio-documents/documents/${d.id}`} className={`font-mono text-xs ${LIEN}`}>{d.number}</a> <span className="text-slate-800">{d.title}</span> <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DOC_STATUS_CLASS[d.status] ?? ""}`}>{DOC_STATUS_LABEL[d.status] ?? d.status}</span></span>
                    <a href={`/studio-documents/documents/${d.id}/pdf`} className={`text-sm font-medium ${LIEN}`}>Télécharger le PDF <span className="sr-only">du document {d.number}</span></a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent></Card>
        </section>
      )}

      <section id="importer" aria-labelledby="importer-titre" className="scroll-mt-4">
      <Card><CardContent className="space-y-3 p-4">
        <h2 id="importer-titre" className="text-sm font-semibold text-slate-900">Importer un PDF</h2>
        <p className="text-xs text-slate-600">Avis de paiement, bon de commande, contrat reçu… Le fichier est conservé tel quel : remplir ou signer crée une nouvelle version, l&apos;original reste intact. {PDF_UPLOAD_LABEL} au maximum.</p>
        <FormulaireRetour action={importPdfAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1 text-xs text-slate-600">Fichier PDF
            <input type="file" name="file" required accept="application/pdf,.pdf" className="block w-full text-sm text-slate-800 file:mr-3 file:rounded-md file:border-0 file:bg-[#0f3460] file:px-3 file:py-2 file:text-sm file:font-medium file:text-white" />
          </label>
          <label className="grid gap-1 text-xs text-slate-600">Titre (facultatif)
            <Input name="title" maxLength={160} placeholder="Par défaut : nom du fichier" />
          </label>
          <div><Button type="submit">Importer</Button></div>
        </FormulaireRetour>
      </CardContent></Card>
      </section>

      <section id="fichiers" aria-label="PDF importés" className="scroll-mt-4">
      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">PDF importés</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Document</th><th scope="col" className="px-3 py-2">Pages</th><th scope="col" className="px-3 py-2">Dernière version</th><th scope="col" className="px-3 py-2">Mis à jour</th></tr></thead>
          <tbody>
            {fichiers.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucun PDF importé.</td></tr>}
            {fichiers.map((f) => (
              <tr key={f.id} className="border-t">
                <td className="px-3 py-2"><a href={`/studio-documents/fichiers/${f.id}`} className="font-medium text-[#0f3460] underline">{f.title}</a> <span className="text-xs text-slate-500">{f.originalName}</span></td>
                <td className="px-3 py-2 tabular-nums">{f.latest?.pageCount ?? "—"}</td>
                <td className="px-3 py-2 text-xs">{f.latest ? `v${f.latest.revision} · ${f.latest.kind === "ORIGINAL" ? (f.origin === "COMBINED" ? "combiné" : f.origin === "EXTRACTED" ? "extrait" : "original") : f.latest.kind === "ORGANIZED" ? "pages organisées" : f.latest.kind === "REDACTED" ? "pages biffées" : f.latest.signerName ? `signée par ${f.latest.signerName}` : "remplie"}` : "—"}</td>
                <td className="px-3 py-2 tabular-nums">{fmtInstant(f.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      </section>

      <section id="combiner" aria-labelledby="combiner-titre" className="scroll-mt-4">
      <Card><CardContent className="space-y-3 p-4">
        <h2 id="combiner-titre" className="text-sm font-semibold text-slate-900">Combiner des PDF</h2>
        <StudioPdfCombiner pdfs={fichiers.filter((f) => f.latest && !f.latest.encrypted).map((f) => ({ id: f.id, title: f.title, pageCount: f.latest!.pageCount, revision: f.latest!.revision }))} />
      </CardContent></Card>
      </section>

      <section id="modeles" aria-label="Modèles et versions" className="scroll-mt-4">
      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Modèles</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Modèle</th><th scope="col" className="px-3 py-2">Catégorie</th><th scope="col" className="px-3 py-2">Versions</th></tr></thead>
          <tbody>
            {templates.length === 0 && <tr><td colSpan={3} className="px-3 py-8 text-center text-slate-400">Aucun modèle.</td></tr>}
            {templates.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-3 py-2"><a href={`/studio-documents/${t.id}`} className="font-medium text-[#0f3460] underline">{t.name}</a></td>
                <td className="px-3 py-2">{CATEGORY_LABEL[t.category as Category] ?? t.category}</td>
                <td className="px-3 py-2 text-xs">{t.versions.map((v) => `v${v.version} ${VERSION_STATUS_LABEL[v.status] ?? v.status}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      </section>

      <section id="nouveau-modele" aria-labelledby="nouveau-modele-titre" className="scroll-mt-4">
      <Card><CardContent className="space-y-3 p-4">
        <h2 id="nouveau-modele-titre" className="text-sm font-semibold text-slate-900">Nouveau modèle (version 1 en brouillon)</h2>
        <div className="space-y-1.5">
          <p className="text-xs text-slate-600">Partir d&apos;une trame (à relire et adapter avant de publier : ce ne sont pas des documents juridiques validés) :</p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {STARTERS.map((st) => (
              <li key={st.id}><a href={`/studio-documents?depart=${st.id}#nouveau-modele`} title={st.description} aria-current={depart?.id === st.id ? "true" : undefined} className={`inline-block rounded-full border px-3 py-1 ${depart?.id === st.id ? "border-[#0f3460] bg-[#0f3460] text-white" : "border-slate-300 text-[#0f3460] hover:bg-slate-50"}`}>{st.label}</a></li>
            ))}
            {depart && <li><a href="/studio-documents#nouveau-modele" className={`inline-block px-1 py-1 text-xs ${LIEN}`}>Repartir d&apos;une page blanche</a></li>}
          </ul>
        </div>
        <FormulaireRetour action={createTemplateAction} className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input key={`nom-${depart?.id ?? "vide"}`} name="name" required minLength={3} maxLength={120} defaultValue={depart?.name ?? ""} placeholder="Nom du modèle" aria-label="Nom du modèle" />
            <select key={`categorie-${depart?.id ?? "vide"}`} name="category" required defaultValue={depart?.category ?? ""} className={SELECT_CLASS} aria-label="Catégorie"><option value="" disabled>Catégorie…</option>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select>
          </div>
          <StudioTemplateEditor
            key={depart?.id ?? "vide"}
            initial={depart ? { title: depart.title, body: depart.body, fields: depart.fields, requiresApproval: depart.requiresApproval } : { title: "", body: "", fields: [], requiresApproval: false }}
            companyName={company?.name ?? "Votre entreprise"} today={formatDay(parisToday(new Date()))} submitLabel="Créer le modèle"
          />
        </FormulaireRetour>
      </CardContent></Card>
      </section>

      <section id="documents" aria-label="Documents générés" className="scroll-mt-4">
      <Card><CardContent className="overflow-x-auto p-0">
        <StudioDocumentSearch q={recherche.q} etat={recherche.etat} />
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Documents générés{filtre ? ` — ${docs.length} résultat${docs.length > 1 ? "s" : ""}${docs.length === 50 ? " (50 premiers)" : ""}` : ""}</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Numéro</th><th scope="col" className="px-3 py-2">Document</th><th scope="col" className="px-3 py-2">État</th><th scope="col" className="px-3 py-2">Date</th></tr></thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">{filtre ? "Aucun document ne correspond à cette recherche." : "Aucun document."}</td></tr>}
            {docs.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="px-3 py-2"><a href={`/studio-documents/documents/${d.id}`} className="font-mono text-xs text-[#0f3460] underline">{d.number}</a></td>
                <td className="px-3 py-2">{d.title} <span className="text-xs text-slate-500">({d.version.template.name} v{d.version.version})</span></td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${DOC_STATUS_CLASS[d.status] ?? ""}`}>{DOC_STATUS_LABEL[d.status] ?? d.status}</span></td>
                <td className="px-3 py-2 tabular-nums">{fmtInstant(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      </section>
    </div>
    </ZoneRetour>
  )
}
