"use client"
// 20/11/2026 — sélecteur du design des PDF : modèle (4 cartes avec vignette), 2 couleurs (palettes prêtes ou code libre),
// format Rapide / Complet, options d'affichage, aperçu PDF. Contrôlé : l'état appartient au parent (paramètres ou brouillon).
// La lisibilité est vérifiée ici pour guider la saisie ; le serveur revalide toujours (validateDesign).
import { Check, Eye } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  PDF_LAYOUTS, PDF_LAYOUT_DESCRIPTION, PDF_LAYOUT_LABEL, PDF_PALETTES, PDF_TEMPLATES, PDF_TEMPLATE_DESCRIPTION, PDF_TEMPLATE_LABEL,
  normalizeHex, tint, validateDesign, type PdfLayout, type PdfTemplate,
} from "@/lib/billing/pdf/design"

export interface PdfDesignValue {
  template: PdfTemplate; primary: string; secondary: string; layout: PdfLayout; showClientIds: boolean; showBankDetails: boolean
}

export function previewUrl(v: PdfDesignValue): string {
  const q = new URLSearchParams({ template: v.template, primary: v.primary, secondary: v.secondary, layout: v.layout, clientIds: v.showClientIds ? "1" : "0", bank: v.showBankDetails ? "1" : "0" })
  return `/api/pdf/apercu-design?${q.toString()}`
}

/** Vignette schématique d'un modèle (pas un rendu réel : l'aperçu PDF fait foi). */
function Thumbnail({ template, primary, secondary }: { template: PdfTemplate; primary: string; secondary: string }) {
  const p = normalizeHex(primary) ?? "#94a3b8", s = normalizeHex(secondary) ?? "#94a3b8"
  const line = (w: string, c = "#cbd5e1", h = 3) => <div style={{ width: w, height: h, background: c, borderRadius: 2 }} />
  return (
    <div className="relative h-28 w-full overflow-hidden rounded-md border bg-white p-2" aria-hidden>
      {template === "BAND" && <div className="-mx-2 -mt-2 mb-2 flex h-8 items-center justify-end px-2" style={{ background: p }}>{line("40%", "#ffffff", 4)}</div>}
      {template !== "BAND" && (
        <div className="mb-2 flex items-start justify-between">
          {line("28%", template === "MINIMAL" ? "#334155" : p, 4)}
          {template === "MODERN" ? <div className="rounded border px-1 text-[6px] font-bold" style={{ borderColor: "#16a34a", color: "#16a34a", transform: "rotate(-7deg)" }}>Payée</div> : line("30%", template === "MINIMAL" ? "#334155" : p, 5)}
        </div>
      )}
      {template === "MINIMAL" && <div className="mb-1.5" style={{ height: 1, background: p }} />}
      <div className="mb-2 flex justify-between gap-2"><div className="flex w-2/5 flex-col gap-1">{line("90%")}{line("70%")}</div><div className="flex w-2/5 flex-col gap-1">{line("90%")}{line("60%")}</div></div>
      <div className="mb-1 h-2.5" style={template === "MODERN" ? { background: p, borderRadius: 4 } : template === "BAND" ? { background: tint(p, 0.12), borderBottom: `1.5px solid ${p}` } : { borderBottom: `1.5px solid ${p}`, background: template === "CLASSIC" ? "#f8fafc" : "#fff" }} />
      <div className="flex flex-col gap-1">{line("100%", "#e2e8f0", 2)}{line("100%", "#e2e8f0", 2)}{line("100%", "#e2e8f0", 2)}</div>
      <div className="absolute bottom-2 right-2 h-3 w-12" style={template === "MODERN" ? { background: tint(s, 0.18), borderRadius: 6 } : template === "BAND" ? { background: p, borderRadius: 2 } : { borderTop: `1.5px solid ${s}` }} />
    </div>
  )
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const valid = normalizeHex(value)
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={`${label} (nuancier)`} value={valid ?? "#000000"} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 cursor-pointer rounded border border-input bg-background p-1" />
      <div className="flex-1">
        <label htmlFor={id} className="text-xs text-slate-500">{label}</label>
        <Input id={id} value={value} maxLength={7} onChange={(e) => onChange(e.target.value)} onBlur={() => { if (valid) onChange(valid) }} className={valid ? "font-mono" : "border-red-400 font-mono"} />
      </div>
    </div>
  )
}

export function PdfDesignPicker({ value, onChange, bankAvailable }: { value: PdfDesignValue; onChange: (v: PdfDesignValue) => void; bankAvailable: boolean }) {
  const set = <K extends keyof PdfDesignValue>(k: K, v: PdfDesignValue[K]) => onChange({ ...value, [k]: v })
  const check = validateDesign(value)
  const activePalette = PDF_PALETTES.find((p) => p.primary === normalizeHex(value.primary) && p.secondary === normalizeHex(value.secondary))?.id ?? null

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Modèle</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup">
          {PDF_TEMPLATES.map((tpl) => {
            const selected = value.template === tpl
            return (
              <button key={tpl} type="button" role="radio" aria-checked={selected} onClick={() => set("template", tpl)}
                className={`rounded-lg border p-2 text-left transition ${selected ? "border-[#0f3460] ring-2 ring-[#0f3460]/30" : "hover:border-slate-400"}`}>
                <Thumbnail template={tpl} primary={value.primary} secondary={value.secondary} />
                <span className="mt-2 flex items-center gap-1 text-sm font-semibold text-slate-800">{selected && <Check className="h-4 w-4 text-[#0f3460]" />}{PDF_TEMPLATE_LABEL[tpl]}</span>
                <span className="block text-xs text-slate-500">{PDF_TEMPLATE_DESCRIPTION[tpl]}</span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Couleurs</legend>
        <div className="mb-3 flex flex-wrap gap-2">
          {PDF_PALETTES.map((p) => (
            <button key={p.id} type="button" onClick={() => onChange({ ...value, primary: p.primary, secondary: p.secondary })} aria-pressed={activePalette === p.id}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${activePalette === p.id ? "border-[#0f3460] bg-slate-50 font-semibold" : "hover:border-slate-400"}`}>
              <span className="flex"><span className="h-4 w-4 rounded-full border border-white" style={{ background: p.primary }} /><span className="-ml-1.5 h-4 w-4 rounded-full border border-white" style={{ background: p.secondary }} /></span>
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ColorField id="pdf-primary" label="Couleur principale (bandeaux, titres)" value={value.primary} onChange={(v) => set("primary", v)} />
          <ColorField id="pdf-secondary" label="Couleur secondaire (totaux, accents)" value={value.secondary} onChange={(v) => set("secondary", v)} />
        </div>
        {!check.ok && <ul className="mt-2 space-y-0.5 text-xs text-red-700" role="alert">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Format</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          {PDF_LAYOUTS.map((l) => (
            <label key={l} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${value.layout === l ? "border-[#0f3460] ring-2 ring-[#0f3460]/30" : "hover:border-slate-400"}`}>
              <input type="radio" name="pdf-layout" className="mt-1" checked={value.layout === l} onChange={() => set("layout", l)} />
              <span><span className="block text-sm font-semibold text-slate-800">{PDF_LAYOUT_LABEL[l]}</span><span className="block text-xs text-slate-500">{PDF_LAYOUT_DESCRIPTION[l]}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">Afficher sur le document</legend>
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={value.showClientIds} onChange={(e) => set("showClientIds", e.target.checked)} />
            <span>SIREN / SIRET et n° de TVA du client<span className="block text-xs text-slate-500">Recommandé entre professionnels (mentions obligatoires sur les factures B2B).</span></span></label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={value.showBankDetails} onChange={(e) => set("showBankDetails", e.target.checked)} />
            <span>Encadré « Coordonnées bancaires »<span className="block text-xs text-slate-500">{bankAvailable ? "IBAN et BIC des paramètres de facturation." : "Aucun IBAN renseigné dans les paramètres de facturation : l'encadré n'apparaîtra pas tant qu'il manque."}</span></span></label>
        </div>
      </fieldset>

      <div>
        {check.ok
          ? <Button type="button" variant="outline" asChild><a href={previewUrl(value)} target="_blank" rel="noopener noreferrer"><Eye className="h-4 w-4" /> Aperçu PDF (document d’exemple)</a></Button>
          : <Button type="button" variant="outline" disabled><Eye className="h-4 w-4" /> Aperçu PDF</Button>}
      </div>
    </div>
  )
}
