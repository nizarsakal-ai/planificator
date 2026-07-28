/**
 * Conversion HTML → texte plain, sans dépendance navigateur.
 * Partageable (Booking / futurs modules) — ne log jamais le contenu.
 */

/** Décode les entités HTML courantes ; 2 passes pour `&amp;nbsp;` etc. */
export function decodeHtmlEntities(text: string): string {
  let s = text
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code < 65536
        ? String.fromCharCode(code)
        : " "
    })
    s = s.replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n)
      return Number.isFinite(code) && code > 0 && code < 65536
        ? String.fromCharCode(code)
        : " "
    })
    s = s.replace(/&nbsp;/gi, " ")
    s = s.replace(/&lt;/gi, "<")
    s = s.replace(/&gt;/gi, ">")
    s = s.replace(/&quot;/gi, '"')
    s = s.replace(/&#39;/gi, "'")
    s = s.replace(/&amp;/gi, "&")
  }
  return s
}

export function htmlToPlainText(html: string): string {
  let s = html
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = decodeHtmlEntities(s)
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  s = s.replace(/[ \t]+\n/g, "\n")
  s = s.replace(/\n{3,}/g, "\n\n")
  s = s.replace(/[ \t]{2,}/g, " ")
  return s.trim()
}
