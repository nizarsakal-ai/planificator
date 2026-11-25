import Link from "next/link"
import type { Block, Inline } from "@/lib/legal/legal-markdown"

// Lot 2a juridique : rendu React d'un texte légal déjà analysé (aucun HTML brut, tout passe par React).

function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text": return <span key={i}>{n.text}</span>
          case "strong": return <strong key={i} className="font-semibold text-slate-900"><InlineView nodes={n.children} /></strong>
          case "em": return <em key={i}><InlineView nodes={n.children} /></em>
          case "code": return <code key={i} className="rounded bg-slate-100 px-1 py-0.5 text-[0.85em]">{n.text}</code>
          case "link":
            return n.href.startsWith("/")
              ? <Link key={i} href={n.href} className="text-blue-700 underline underline-offset-2"><InlineView nodes={n.children} /></Link>
              : <a key={i} href={n.href} rel="noopener noreferrer" target="_blank" className="text-blue-700 underline underline-offset-2"><InlineView nodes={n.children} /></a>
        }
      })}
    </>
  )
}

const HEADING_CLASS = {
  1: "text-2xl font-bold text-slate-900 mt-2 mb-4",
  2: "text-lg font-semibold text-slate-900 mt-8 mb-3",
  3: "text-base font-semibold text-slate-900 mt-6 mb-2",
  4: "text-sm font-semibold text-slate-900 mt-4 mb-2",
} as const

export function LegalDocumentView({ blocks }: { blocks: Block[] }) {
  return (
    <div className="text-sm leading-relaxed text-slate-700">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const Tag = (`h${b.level}` as "h1" | "h2" | "h3" | "h4")
            return <Tag key={i} className={HEADING_CLASS[b.level]}><InlineView nodes={b.children} /></Tag>
          }
          case "paragraph": return <p key={i} className="my-3"><InlineView nodes={b.children} /></p>
          case "rule": return <hr key={i} className="my-6 border-slate-200" />
          case "list": {
            const Tag = b.ordered ? "ol" : "ul"
            return (
              <Tag key={i} className={`my-3 space-y-1 pl-5 ${b.ordered ? "list-decimal" : "list-disc"}`}>
                {b.items.map((item, j) => <li key={j}><InlineView nodes={item} /></li>)}
              </Tag>
            )
          }
          case "table":
            return (
              <div key={i} className="my-4 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="bg-slate-50">
                    <tr>{b.header.map((c, j) => <th key={j} scope="col" className="border-b border-slate-200 px-3 py-2 font-semibold text-slate-900"><InlineView nodes={c} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j} className="align-top odd:bg-white even:bg-slate-50/50">
                        {row.map((c, k) => <td key={k} className="border-b border-slate-100 px-3 py-2"><InlineView nodes={c} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
    </div>
  )
}

/** Liens vers les pages légales, pour les pieds de page (connexion, inscription, profil). */
export function LegalLinks({ className = "" }: { className?: string }) {
  const links = [
    { href: "/mentions-legales", label: "Mentions légales" },
    { href: "/confidentialite", label: "Confidentialité" },
    { href: "/cgu", label: "CGU" },
  ]
  return (
    <nav aria-label="Informations légales" className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-500 ${className}`}>
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="underline-offset-2 hover:text-slate-700 hover:underline">{l.label}</Link>
      ))}
    </nav>
  )
}
