/**
 * Lot D Planificator V2 : recherche globale côté serveur. Chaque requête est bornée par `companyId` (session) et
 * limitée aux groupes autorisés (`allowedGroups`) ; au plus 5 résultats par groupe, champs d'affichage seulement
 * (aucun montant, aucune donnée RH : le groupe « employés » n'existe pas).
 */
import type { PrismaClient } from "@prisma/client"
import { PER_GROUP, allowedGroups, hrefFor, normalizeQuery, type SearchFlags, type SearchGroup, type SearchHit } from "@/lib/search/search.core"

type Db = PrismaClient
export interface SearchContext { companyId: string; role: string }

const ci = (q: string) => ({ contains: q, mode: "insensitive" as const })

export async function globalSearch(db: Db, ctx: SearchContext, rawQuery: string, flags: SearchFlags): Promise<{ query: string | null; groups: { group: SearchGroup; hits: SearchHit[] }[] }> {
  const q = normalizeQuery(rawQuery)
  const groups = allowedGroups(ctx.role, flags)
  if (!q || groups.length === 0) return { query: q, groups: [] }
  const companyId = ctx.companyId
  const take = PER_GROUP
  const run: Record<SearchGroup, () => Promise<SearchHit[]>> = {
    worksites: async () => (await db.worksite.findMany({ where: { companyId, OR: [{ name: ci(q) }, { address: ci(q) }] }, orderBy: [{ name: "asc" }, { id: "asc" }], take, select: { id: true, name: true, address: true, archivedAt: true } }))
      .map((w) => ({ group: "worksites" as const, id: w.id, title: w.name, subtitle: [w.address, w.archivedAt ? "archivé" : null].filter(Boolean).join(" · ") || null, href: hrefFor("worksites", w.id) })),
    clients: async () => (await db.client.findMany({ where: { companyId, OR: [{ name: ci(q) }, { email: ci(q) }] }, orderBy: [{ name: "asc" }, { id: "asc" }], take, select: { id: true, name: true, active: true } }))
      .map((c) => ({ group: "clients" as const, id: c.id, title: c.name, subtitle: c.active ? null : "inactif", href: hrefFor("clients", c.id) })),
    quotes: async () => (await db.quote.findMany({ where: { companyId, OR: [{ number: ci(q) }, { subject: ci(q) }] }, orderBy: [{ issueDate: "desc" }, { id: "desc" }], take, select: { id: true, number: true, subject: true, client: { select: { name: true } } } }))
      .map((d) => ({ group: "quotes" as const, id: d.id, title: d.number, subtitle: [d.subject, d.client.name].filter(Boolean).join(" · ") || null, href: hrefFor("quotes", d.id) })),
    invoices: async () => (await db.invoice.findMany({ where: { companyId, OR: [{ number: ci(q) }, { subject: ci(q) }] }, orderBy: [{ issueDate: "desc" }, { id: "desc" }], take, select: { id: true, number: true, subject: true, client: { select: { name: true } } } }))
      .map((i) => ({ group: "invoices" as const, id: i.id, title: i.number, subtitle: [i.subject, i.client.name].filter(Boolean).join(" · ") || null, href: hrefFor("invoices", i.id) })),
    articles: async () => (await db.article.findMany({ where: { companyId, OR: [{ designation: ci(q) }, { reference: ci(q) }] }, orderBy: [{ designation: "asc" }, { id: "asc" }], take, select: { id: true, designation: true, reference: true } }))
      .map((a) => ({ group: "articles" as const, id: a.id, title: a.designation, subtitle: a.reference, href: hrefFor("articles", a.id) })),
    equipment: async () => (await db.equipment.findMany({ where: { companyId, OR: [{ number: ci(q) }, { name: ci(q) }, { serialNumber: ci(q) }] }, orderBy: [{ number: "asc" }, { id: "asc" }], take, select: { id: true, number: true, name: true } }))
      .map((e) => ({ group: "equipment" as const, id: e.id, title: `${e.number} · ${e.name}`, subtitle: null, href: hrefFor("equipment", e.id) })),
    reserves: async () => (await db.worksiteReserve.findMany({ where: { companyId, OR: [{ number: ci(q) }, { title: ci(q) }, { location: ci(q) }] }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: { id: true, number: true, title: true, worksiteId: true, worksite: { select: { name: true } } } }))
      .map((r) => ({ group: "reserves" as const, id: r.id, title: `${r.number} · ${r.title}`, subtitle: r.worksite.name, href: hrefFor("reserves", r.id, { worksiteId: r.worksiteId }) })),
  }
  const results = await Promise.all(groups.map(async (g) => ({ group: g, hits: await run[g]() })))
  return { query: q, groups: results.filter((r) => r.hits.length > 0) }
}
