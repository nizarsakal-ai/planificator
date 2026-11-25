// Lot 2a juridique : lecteur Markdown minimal et pur pour les textes de docs/legal (titres, paragraphes, listes,
// tableaux, séparateurs, gras, italique, code, liens). Volontairement limité au sous-ensemble utilisé par ces textes :
// aucune dépendance ajoutée, aucun HTML brut accepté (tout est rendu en texte par React).

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] }

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" }

const PLACEHOLDER = /\[À (COMPLÉTER|VÉRIFIER)\b/

/** Le texte contient encore des champs à compléter ou à vérifier. */
export function hasPlaceholders(markdown: string): boolean {
  return PLACEHOLDER.test(markdown)
}

/**
 * Retire la note de travail en tête de fichier (« *Brouillon du …* », « *Modèle du …* ») : elle s'adresse à l'équipe,
 * pas au lecteur de la page publique.
 */
export function stripDraftNote(markdown: string): string {
  return markdown.replace(/^(#[^\n]*\n+)\*(Brouillon|Modèle) [^\n]*\*\n+/, "$1")
}

export function parseInline(text: string, mapHref: (href: string) => string = (h) => h): Inline[] {
  const out: Inline[] = []
  let buffer = ""
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer })
    buffer = ""
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    let m: RegExpMatchArray | null
    if ((m = rest.match(/^`([^`]+)`/))) {
      flush()
      out.push({ kind: "code", text: m[1] })
    } else if ((m = rest.match(/^\*\*(.+?)\*\*/))) {
      flush()
      out.push({ kind: "strong", children: parseInline(m[1], mapHref) })
    } else if ((m = rest.match(/^\*([^*\s][^*]*?)\*/))) {
      flush()
      out.push({ kind: "em", children: parseInline(m[1], mapHref) })
    } else if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      flush()
      out.push({ kind: "link", href: mapHref(m[2]), children: parseInline(m[1], mapHref) })
    } else {
      buffer += text[i]
      i += 1
      continue
    }
    i += m[0].length
  }
  flush()
  return out
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)
const LIST_ITEM = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/

export function parseLegalMarkdown(markdown: string, mapHref: (href: string) => string = (h) => h): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2 | 3 | 4, children: parseInline(heading[2].trim(), mapHref) })
      i += 1
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule" })
      i += 1
      continue
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line).map((c) => parseInline(c, mapHref))
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]).map((c) => parseInline(c, mapHref)))
        i += 1
      }
      blocks.push({ kind: "table", header, rows })
      continue
    }
    const first = line.match(LIST_ITEM)
    if (first) {
      const ordered = first[2] !== undefined
      const items: Inline[][] = []
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM)
        if (m && (m[2] !== undefined) === ordered) {
          items.push(parseInline(m[3].trim(), mapHref))
          i += 1
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          // Ligne de suite ou sous-élément : rattachée à l'élément courant.
          const sub = lines[i].match(LIST_ITEM)
          const last = items[items.length - 1]
          last.push({ kind: "text", text: sub ? " · " : " " }, ...parseInline((sub ? sub[3] : lines[i]).trim(), mapHref))
          i += 1
        } else break
      }
      blocks.push({ kind: "list", ordered, items })
      continue
    }
    // Paragraphe : la ligne courante est toujours consommée (aucune boucle infinie sur une ligne isolée « | … »).
    const para: string[] = [line.trim()]
    i += 1
    while (
      i < lines.length && lines[i].trim() && !/^#{1,4}\s/.test(lines[i]) && !LIST_ITEM.test(lines[i]) &&
      !lines[i].trim().startsWith("|") && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i += 1
    }
    blocks.push({ kind: "paragraph", children: parseInline(para.join(" "), mapHref) })
  }
  return blocks
}
