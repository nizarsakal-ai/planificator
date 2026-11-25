"use client"
// Lot G2 Planificator V2 : éditeur visuel d'une version de modèle du Document Studio. Il se place DANS un FormulaireRetour
// (création d'un modèle ou enregistrement d'un brouillon) et fournit les champs envoyés : « title », « body », « fieldsJson »
// (déclaration des champs en JSON) et « requiresApproval ».
//  - Tableau des champs : ajouter, supprimer, réordonner ; la clé est proposée d'après le libellé ; options d'une liste de
//    choix, aide et valeur par défaut.
//  - Barre de mise en forme et insertion d'un champ à l'endroit du curseur.
//  - Contrôle de cohérence et aperçu calculés dans le navigateur avec les MÊMES règles pures que le serveur
//    (`studio.format`), sur des valeurs d'exemple. Rien n'est enregistré avant l'envoi ; le serveur revalide tout.
import { useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS } from "@/components/stock/StockFlash"
import {
  FIELD_TYPES, FIELD_TYPE_LABEL, MAX_FIELDS, PAGE_BREAK, SYSTEM_FIELDS, SYSTEM_FIELD_LABEL, filler, keyFromLabel, renderBlocks, sampleSystem, sampleValues,
  validateVersionContent, type FieldDef, type FieldType,
} from "@/lib/document-studio/studio.format"
import { StudioBlocks } from "@/components/document-studio/StudioBlocks"
import { SYNTAX_HELP } from "@/components/document-studio/labels"

interface Row { id: number; key: string; keyEdited: boolean; label: string; type: FieldType; required: boolean; options: string; help: string; defaultValue: string }
export interface EditorInitial { title: string; body: string; fields: FieldDef[]; requiresApproval: boolean }

const AREA = "rounded-md border border-input bg-background p-2 text-sm"
const TOOL = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f3460]"
const KEY_OK = /^[a-z][a-z0-9_]{0,39}$/

const toRow = (f: FieldDef, id: number): Row => ({ id, key: f.key, keyEdited: true, label: f.label, type: f.type, required: f.required, options: (f.options ?? []).join("\n"), help: f.help ?? "", defaultValue: f.defaultValue ?? "" })
/** Forme envoyée au serveur (et relue par les règles pures) : seules les propriétés utiles au type sont présentes. */
function toDef(r: Row): Record<string, unknown> {
  const options = r.options.split("\n").map((o) => o.trim()).filter(Boolean)
  return {
    key: r.key.trim(), label: r.label.trim(), type: r.type, required: r.required,
    ...(r.type === "CHOICE" ? { options } : {}),
    ...(r.help.trim() ? { help: r.help.trim() } : {}),
    ...(r.defaultValue.trim() ? { defaultValue: r.defaultValue.trim() } : {}),
  }
}

export function StudioTemplateEditor({ initial, companyName, today, submitLabel }: { initial: EditorInitial; companyName: string; today: string; submitLabel: string }) {
  const [title, setTitle] = useState(initial.title)
  const [body, setBody] = useState(initial.body)
  const [rows, setRows] = useState<Row[]>(() => initial.fields.map(toRow))
  const [approval, setApproval] = useState(initial.requiresApproval)
  const nextId = useRef(initial.fields.length)
  const area = useRef<HTMLTextAreaElement>(null)

  const defs = useMemo(() => rows.map(toDef), [rows])
  const check = useMemo(() => validateVersionContent({ title, body, fields: defs, requiresApproval: approval }), [title, body, defs, approval])
  const preview = useMemo(() => {
    // Aperçu tolérant : champs utilisables même si l'ensemble n'est pas encore valide ; un champ non déclaré reste visible.
    const usable = defs.filter((d) => typeof d.key === "string" && KEY_OK.test(d.key)) as unknown as FieldDef[]
    const fill = filler(usable, sampleValues(usable, today), sampleSystem(companyName, today), (k) => `{{${k}}}`)
    return { title: fill(title).trim(), blocks: renderBlocks(body.replace(/\r\n?/g, "\n"), fill) }
  }, [title, body, defs, companyName, today])

  const patch = (id: number, change: Partial<Row>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change } : r)))
  const setLabel = (r: Row, label: string) => patch(r.id, r.keyEdited ? { label } : { label, key: keyFromLabel(label) })
  const move = (index: number, delta: number) => setRows((all) => {
    const to = index + delta
    if (to < 0 || to >= all.length) return all
    const copy = [...all]
    ;[copy[index], copy[to]] = [copy[to], copy[index]]
    return copy
  })
  const add = () => setRows((all) => (all.length >= MAX_FIELDS ? all : [...all, { id: nextId.current++, key: "", keyEdited: false, label: "", type: "TEXT", required: true, options: "", help: "", defaultValue: "" }]))

  /** Remplace la sélection du corps par `before + sélection (ou exemple) + after` ; `line` : sur une ligne à part. */
  const insert = (before: string, after = "", sample = "", line = false) => {
    const el = area.current
    const start = el ? el.selectionStart : body.length
    const end = el ? el.selectionEnd : body.length
    const selected = body.slice(start, end) || sample
    const lead = line && start > 0 && body[start - 1] !== "\n" ? "\n" : ""
    const text = `${lead}${before}${selected}${after}`
    setBody(`${body.slice(0, start)}${text}${body.slice(end)}`)
    const caret = start + text.length
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret) })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="grid min-w-0 content-start gap-3">
        <label className="grid gap-1 text-sm"><span className="font-medium text-slate-800">Titre du document</span>
          <Input name="title" required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Attestation de travaux {{numero}}" />
        </label>

        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium text-slate-800">Champs à remplir à la génération</legend>
          {rows.length === 0 && <p className="text-xs text-slate-600">Aucun champ : le document n&apos;utilisera que les champs automatiques.</p>}
          <ul className="grid gap-2">
            {rows.map((r, i) => (
              <li key={r.id} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
                  <Input value={r.label} onChange={(e) => setLabel(r, e.target.value)} maxLength={80} placeholder="Libellé, ex. Nature des travaux" aria-label={`Libellé du champ ${i + 1}`} className="h-9 bg-white" />
                  <Input value={r.key} onChange={(e) => patch(r.id, { key: e.target.value.toLowerCase(), keyEdited: true })} maxLength={40} placeholder="clé" aria-label={`Clé du champ ${i + 1}`} aria-invalid={r.key !== "" && !KEY_OK.test(r.key)} className="h-9 bg-white font-mono text-xs" />
                  <select value={r.type} onChange={(e) => patch(r.id, { type: e.target.value as FieldType, defaultValue: "" })} aria-label={`Type du champ ${i + 1}`} className={`${SELECT_CLASS} h-9 bg-white`}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}
                  </select>
                </div>
                {r.type === "CHOICE" && (
                  <textarea value={r.options} onChange={(e) => patch(r.id, { options: e.target.value })} rows={3} placeholder={"Un choix par ligne\nex. À réception de facture"} aria-label={`Choix du champ ${i + 1}`} className={`${AREA} bg-white text-xs`} />
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {r.type === "CHECKBOX"
                    ? <label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={r.defaultValue === "oui"} onChange={(e) => patch(r.id, { defaultValue: e.target.checked ? "oui" : "" })} /> Cochée par défaut</label>
                    : <Input value={r.defaultValue} onChange={(e) => patch(r.id, { defaultValue: e.target.value })} type={r.type === "DATE" ? "date" : "text"} maxLength={500} placeholder="Valeur par défaut (facultative)" aria-label={`Valeur par défaut du champ ${i + 1}`} className="h-9 bg-white text-xs" />}
                  <Input value={r.help} onChange={(e) => patch(r.id, { help: e.target.value })} maxLength={200} placeholder="Aide affichée sous le champ (facultative)" aria-label={`Aide du champ ${i + 1}`} className="h-9 bg-white text-xs" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="mr-auto flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={r.required} onChange={(e) => patch(r.id, { required: e.target.checked })} /> {r.type === "CHECKBOX" ? "Doit être cochée" : "Obligatoire"}</label>
                  <button type="button" className={TOOL} disabled={!KEY_OK.test(r.key)} onClick={() => insert(`{{${r.key}}}`)}>Insérer dans le texte</button>
                  <button type="button" className={TOOL} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Monter le champ ${i + 1}`}>↑</button>
                  <button type="button" className={TOOL} disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Descendre le champ ${i + 1}`}>↓</button>
                  <button type="button" className={`${TOOL} text-red-700`} onClick={() => setRows((all) => all.filter((x) => x.id !== r.id))} aria-label={`Supprimer le champ ${i + 1}`}>Supprimer</button>
                </div>
              </li>
            ))}
          </ul>
          <div><Button type="button" size="sm" variant="outline" onClick={add} disabled={rows.length >= MAX_FIELDS}>Ajouter un champ</Button></div>
          <input type="hidden" name="fieldsJson" value={JSON.stringify(defs)} />
        </fieldset>

        <div className="grid gap-1">
          <span className="text-sm font-medium text-slate-800" id="studio-corps-titre">Corps du document</span>
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Mise en forme">
            <button type="button" className={TOOL} onClick={() => insert("# ", "", "Titre", true)}>Titre</button>
            <button type="button" className={TOOL} onClick={() => insert("## ", "", "Sous-titre", true)}>Sous-titre</button>
            <button type="button" className={`${TOOL} font-bold`} onClick={() => insert("**", "**", "texte")}>Gras</button>
            <button type="button" className={TOOL} onClick={() => insert("- ", "", "élément", true)}>Liste</button>
            <button type="button" className={TOOL} onClick={() => insert("1. ", "", "élément", true)}>Liste numérotée</button>
            <button type="button" className={TOOL} onClick={() => insert("| Colonne 1 | Colonne 2 |\n| ", " |  |\n", "valeur", true)}>Tableau</button>
            <button type="button" className={TOOL} onClick={() => insert(`\n${PAGE_BREAK}\n\n`, "", "", true)}>Saut de page</button>
            <select value="" onChange={(e) => { if (e.target.value) insert(`{{${e.target.value}}}`) }} aria-label="Insérer un champ automatique" className={`${SELECT_CLASS} h-8 max-w-[14rem] text-xs`}>
              <option value="">Champ automatique…</option>
              {SYSTEM_FIELDS.map((k) => <option key={k} value={k}>{SYSTEM_FIELD_LABEL[k]}</option>)}
            </select>
          </div>
          <textarea ref={area} name="body" required maxLength={20000} rows={16} value={body} onChange={(e) => setBody(e.target.value)} aria-labelledby="studio-corps-titre" placeholder={"# Objet\nNous attestons que les travaux de {{nature}} ont été réalisés pour {{client}}."} className={`${AREA} font-mono text-[13px] leading-relaxed`} />
          <details className="text-xs text-slate-600">
            <summary className="cursor-pointer select-none">Aide-mémoire de la mise en forme</summary>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {SYNTAX_HELP.map(([code, meaning]) => <div key={code} className="contents"><dt className="font-mono">{code}</dt><dd>{meaning}</dd></div>)}
            </dl>
          </details>
        </div>

        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requiresApproval" value="oui" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Validation par un second administrateur avant émission</label>
        {(title.trim() !== "" || body.trim() !== "") && (
          check.ok
            ? <p role="status" className="text-xs text-green-700">Contenu cohérent : tous les champs cités sont déclarés et tous les champs déclarés sont cités.</p>
            : <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">À corriger avant publication : {check.error}</p>
        )}
        <div><Button type="submit" variant="outline">{submitLabel}</Button></div>
      </div>

      <section aria-label="Aperçu du document" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">Aperçu avec des valeurs d&apos;exemple</h3>
        <div className="max-h-[75vh] space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <p className="text-base font-bold text-[#0f3460]">{preview.title || "Titre du document"}</p>
          {preview.blocks.length === 0 ? <p className="text-slate-400">Le corps du document apparaîtra ici.</p> : <StudioBlocks blocks={preview.blocks} />}
        </div>
      </section>
    </div>
  )
}
