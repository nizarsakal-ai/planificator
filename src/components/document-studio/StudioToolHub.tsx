"use client"
// Lot G Planificator V2 (accueil-v3) : matrice d'outils du Document Studio avec recherche à la frappe. Composant client
// minimal : ensemble de cartes STATIQUE (lib/document-studio/tool-hub.ts), aucune donnée métier ni action serveur. Chaque
// carte est UN seul lien HTML natif vers une section stable ou une vue bornée. Sans JavaScript, toutes les cartes sont
// rendues par le serveur et restent utilisables. Aucune animation obligatoire (léger décalage de la flèche au survol,
// seulement si le mouvement n'est pas réduit).
// Lot G2 : `contexte` (modèle de départ et recherche déjà validés par la page) est reconduit par les cartes qui ouvrent une vue.
import { useId, useRef, useState } from "react"
import { ArrowRight, Combine, Download, FilePlus2, FileSearch, FileUp, Files, PenLine, Search, ShieldCheck, Sparkles, X, type LucideIcon } from "lucide-react"
import { STUDIO_TOOLS, TOOL_FAMILIES, adresseVue, filtrerOutils, type StudioContexte, type StudioTool, type ToolFamilyId } from "@/lib/document-studio/tool-hub"

const ICONES: Record<StudioTool["id"], LucideIcon> = {
  "nouveau-modele": FilePlus2, generer: Sparkles, modeles: Files, documents: FileSearch, validation: ShieldCheck, pdf: Download, "importer-pdf": FileUp, "pdf-importes": PenLine, "combiner-pdf": Combine,
}
/** Couleur par famille : bleu Planificator, sarcelle, violet, carmin (espace PDF) (pastilles claires assombries par l'apparence sombre). */
const FAMILLE: Record<ToolFamilyId, { tuile: string; point: string }> = {
  creer: { tuile: "bg-blue-50 text-[#0f3460]", point: "bg-[#0f3460]" },
  retrouver: { tuile: "bg-teal-50 text-[#0d766d]", point: "bg-[#0d766d]" },
  valider: { tuile: "bg-violet-50 text-[#6d4acb]", point: "bg-[#6d4acb]" },
  pdf: { tuile: "bg-rose-50 text-[#b4233c]", point: "bg-[#b4233c]" },
}

const SANS_CONTEXTE: Partial<Omit<StudioContexte, "vue">> = {}

export function StudioToolHub({ contexte = SANS_CONTEXTE }: { contexte?: Partial<Omit<StudioContexte, "vue">> }) {
  const [saisie, setSaisie] = useState("")
  const champ = useRef<HTMLInputElement>(null)
  const id = useId()
  const visibles = filtrerOutils(saisie, STUDIO_TOOLS)
  const effacer = () => { setSaisie(""); champ.current?.focus() }

  return (
    <div className="space-y-5">
      <div className="relative max-w-xl">
        <label htmlFor={`${id}-recherche`} className="sr-only">Rechercher un outil</label>
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          ref={champ}
          id={`${id}-recherche`}
          type="search"
          value={saisie}
          onChange={(e) => setSaisie(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && saisie) { e.preventDefault(); setSaisie("") } }}
          placeholder="Rechercher un outil"
          autoComplete="off"
          maxLength={100}
          aria-describedby={`${id}-resultat`}
          className="h-11 w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-500 focus-visible:border-[#0f3460] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460]/30"
        />
        <p id={`${id}-resultat`} aria-live="polite" className="sr-only">
          {saisie.trim() ? `${visibles.length} outil${visibles.length > 1 ? "s" : ""} trouvé${visibles.length > 1 ? "s" : ""}` : ""}
        </p>
      </div>

      {visibles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center">
          <p className="text-sm text-slate-800">Aucun outil ne correspond à « {saisie.trim()} ».</p>
          <button type="button" onClick={effacer} className="mt-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-[#0f3460] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460]">
            <X aria-hidden="true" className="h-4 w-4" /> Effacer la recherche
          </button>
        </div>
      ) : (
        TOOL_FAMILIES.map((f) => {
          const outils = visibles.filter((o) => o.family === f.id)
          if (outils.length === 0) return null
          return (
            <section key={f.id} aria-labelledby={`${id}-${f.id}`} className="space-y-2.5">
              <h2 id={`${id}-${f.id}`} className="flex items-center gap-2 border-b border-slate-300 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${FAMILLE[f.id].point}`} />{f.label}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {outils.map((o) => {
                  const Icone = ICONES[o.id]
                  return (
                    <li key={o.id} className="min-w-0">
                      <a
                        href={adresseVue(o.href, contexte)}
                        className="group flex h-full items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-2"
                      >
                        <span aria-hidden="true" className={`shrink-0 rounded-xl p-2 ${FAMILLE[f.id].tuile}`}><Icone className="h-5 w-5" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-slate-800">{o.title}</span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-slate-600">{o.description}</span>
                        </span>
                        <ArrowRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#0f3460] motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
                      </a>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })
      )}
    </div>
  )
}
