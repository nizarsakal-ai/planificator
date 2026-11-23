// Lot D Planificator V2 : réserves de réception de l'entreprise (filtre d'état), synthèse par chantier.
// Drapeau WORKSITE_RESERVES_ENABLED + ADMIN/SUPER_ADMIN.
import Link from "next/link"
import { ClipboardCheck } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { reservePageAccess } from "@/lib/reserves/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { listReserves, reserveCountsByWorksite } from "@/lib/reserves/queries"
import { MAX_LISTED_RESERVES, SEVERITY_LABEL, STATUS_LABEL } from "@/lib/reserves/reserves.core"
import { Card, CardContent } from "@/components/ui/card"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { Button } from "@/components/ui/button"
import { fmtDay } from "@/components/equipment/labels"
import { RESERVE_STATUS_CLASS, SEVERITY_CLASS } from "@/components/reserves/labels"

const STATUSES = ["OPEN", "LIFTED", "CANCELLED"] as const

export default async function ReservesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await reservePageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (même règle que les lots A, B et C).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const status = STATUSES.find((s) => s === params.etat) ?? (params.etat === "tous" ? undefined : "OPEN")
  const [reserves, counts, sites] = await Promise.all([
    listReserves(prisma, ctx.companyId, status),
    reserveCountsByWorksite(prisma, ctx.companyId),
    prisma.worksite.findMany({ where: { companyId: ctx.companyId, archivedAt: null }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true } }),
  ])
  const openTotal = [...counts.values()].reduce((t, c) => t + c.open, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><ClipboardCheck className="h-6 w-6 text-[#0f3460]" /> Réserves et réception</h1>
          <p className="mt-1 text-sm text-slate-500">{openTotal} réserve{openTotal > 1 ? "s" : ""} ouverte{openTotal > 1 ? "s" : ""} · procès-verbaux signés et figés</p>
        </div>
        <form className="flex flex-wrap gap-2" action="/reserves">
          <select name="etat" defaultValue={status ?? "tous"} className={SELECT_CLASS} aria-label="État des réserves">
            <option value="OPEN">Ouvertes</option><option value="LIFTED">Levées</option><option value="CANCELLED">Annulées</option><option value="tous">Toutes</option>
          </select>
          <Button type="submit" variant="outline">Filtrer</Button>
        </form>
      </div>
      <StockFlash params={params} />

      <Card><CardContent className="space-y-2 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Ouvrir un chantier</h2>
        <form className="flex flex-wrap gap-2" action="/reserves/chantier">
          <select name="id" required defaultValue="" className={SELECT_CLASS} aria-label="Chantier">
            <option value="" disabled>Chantier…</option>
            {sites.map((w) => <option key={w.id} value={w.id}>{w.name}{counts.get(w.id)?.open ? ` · ${counts.get(w.id)!.open} ouverte(s)` : ""}</option>)}
          </select>
          <Button type="submit">Réserves du chantier</Button>
        </form>
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="sr-only">Réserves de réception</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">N°</th><th scope="col" className="px-3 py-2">Réserve</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Chantier</th><th scope="col" className="hidden px-3 py-2 md:table-cell">Gravité</th><th scope="col" className="hidden px-3 py-2 lg:table-cell">Échéance</th><th scope="col" className="px-3 py-2">État</th></tr></thead>
          <tbody>
            {reserves.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Aucune réserve.</td></tr>}
            {reserves.map((r) => (
              <tr key={r.id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-medium tabular-nums">{r.number}</td>
                <td className="px-3 py-2">{r.title}<div className="text-xs text-slate-500">{r.location}</div></td>
                <td className="hidden px-3 py-2 md:table-cell"><Link href={`/reserves/${r.worksite.id}`} className="text-[#0f3460] hover:underline">{r.worksite.name}</Link></td>
                <td className="hidden px-3 py-2 md:table-cell"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[r.severity] ?? ""}`}>{SEVERITY_LABEL[r.severity]}</span></td>
                <td className="hidden px-3 py-2 tabular-nums lg:table-cell">{r.dueDate ? fmtDay(r.dueDate) : "—"}</td>
                <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${RESERVE_STATUS_CLASS[r.status] ?? ""}`}>{STATUS_LABEL[r.status]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>
      {reserves.length === MAX_LISTED_RESERVES && <p role="status" className="text-xs text-slate-500">Affichage limité aux {MAX_LISTED_RESERVES} réserves les plus récentes : liste partielle.</p>}
    </div>
  )
}
