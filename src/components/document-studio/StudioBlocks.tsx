// Lot G2 Planificator V2 : affichage à l'écran des blocs d'un document du Document Studio (intertitres, sous-titres,
// paragraphes, gras, listes, tableaux, sauts de page). Composant sans état ni effet : il sert à la fiche d'un document
// généré (serveur) comme à l'aperçu de l'éditeur (navigateur). Le texte est rendu tel quel par React (aucun HTML injecté).
import type { Block, Run } from "@/lib/document-studio/studio.format"

function Runs({ text, runs }: { text: string; runs?: Run[] }) {
  if (!runs) return <>{text}</>
  return <>{runs.map((r, i) => (r.bold ? <strong key={i} className="font-semibold">{r.text}</strong> : <span key={i}>{r.text}</span>))}</>
}

export function StudioBlocks({ blocks }: { blocks: readonly Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "heading") return <h2 key={i} className="pt-2 font-semibold text-[#0f3460]">{b.text}</h2>
        if (b.kind === "subheading") return <h3 key={i} className="pt-1 text-sm font-semibold text-slate-700">{b.text}</h3>
        if (b.kind === "pagebreak") return <div key={i} role="separator" aria-label="Saut de page" className="my-3 border-t border-dashed border-slate-300 pt-1 text-center text-[11px] uppercase tracking-wide text-slate-400">Saut de page</div>
        if (b.kind === "list" && b.items) {
          return (
            <ul key={i} className="space-y-0.5">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2"><span aria-hidden={!it.marker} className="w-6 shrink-0 text-slate-500">{it.marker ?? "•"}</span><span className="min-w-0 whitespace-pre-line"><Runs text={it.text} runs={it.runs} /></span></li>
              ))}
            </ul>
          )
        }
        if (b.kind === "table" && b.rows) {
          const [head, ...rows] = b.rows
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full border border-slate-200 text-left text-sm">
                <thead className="bg-slate-50"><tr>{head.map((c, j) => <th key={j} scope="col" className="border-b border-slate-200 px-2 py-1 font-semibold">{c}</th>)}</tr></thead>
                <tbody>{rows.map((r, j) => <tr key={j} className="border-t border-slate-100">{r.map((c, k) => <td key={k} className="px-2 py-1 align-top">{c}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )
        }
        return <p key={i} className="whitespace-pre-line"><Runs text={b.text} runs={b.runs} /></p>
      })}
    </>
  )
}
