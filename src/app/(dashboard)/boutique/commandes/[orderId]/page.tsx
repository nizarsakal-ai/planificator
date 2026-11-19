// Lot I Planificator V2 : fiche d'une commande boutique de SIMULATION — lignes et totaux FIGÉS au moment de la commande
// (libellé, prix HT, TVA de l'article ; promotion), attribution marketing éventuelle. Lecture seule : aucun paiement,
// aucune facture, aucun devis, aucun stock. Drapeau MARKETING_SHOP_ENABLED + ADMIN/SUPER_ADMIN ; commande d'une autre
// société ⇒ introuvable. Refus rendu sur place avant toute lecture (AdminOnlyNotice), liens HTML natifs.
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { marketingShopPageAccess } from "@/lib/marketing-shop/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getOrder } from "@/lib/marketing-shop/queries"
import { bpToPercentString, formatEuro } from "@/lib/billing/money"
import { Card, CardContent } from "@/components/ui/card"
import { StockFlash } from "@/components/stock/StockFlash"
import { MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

const ID = /^[A-Za-z0-9_-]{1,64}$/
const pct = (bp: number) => `${bpToPercentString(bp).replace(".", ",")} %`

export default async function ShopOrderPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await marketingShopPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const { orderId } = await params
  const sp = await searchParams
  if (!ID.test(orderId)) notFound()
  const o = await getOrder(prisma, ctx.companyId, orderId)
  if (!o) notFound()
  const conversion = o.conversions[0] ?? null

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <a href="/boutique" className="text-xs text-[#0f3460] underline">← Boutique</a>
        <h1 className="text-2xl font-bold text-slate-900">Commande de simulation · {o.client.name}</h1>
        <p className="text-sm text-slate-500">Enregistrée le {fmtInstant(o.createdAt)} · prix et taux figés à cette date · aucun paiement, aucune facture</p>
      </div>
      <MessageRetour><StockFlash params={sp} /></MessageRetour>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Lignes</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th scope="col" className="px-3 py-2">Article</th><th scope="col" className="px-3 py-2 text-right">Quantité</th><th scope="col" className="px-3 py-2 text-right">Prix HT</th>
            <th scope="col" className="px-3 py-2 text-right">Brut HT</th><th scope="col" className="px-3 py-2 text-right">Remise</th><th scope="col" className="px-3 py-2 text-right">Net HT</th>
            <th scope="col" className="px-3 py-2 text-right">TVA</th><th scope="col" className="px-3 py-2 text-right">Montant TVA</th>
          </tr></thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.position} className="border-t tabular-nums">
                <td className="px-3 py-2">{l.designation} <span className="text-xs text-slate-500">({l.unit})</span></td><td className="px-3 py-2 text-right">{l.quantity}</td>
                <td className="px-3 py-2 text-right">{formatEuro(l.unitPriceCents)}</td><td className="px-3 py-2 text-right">{formatEuro(l.grossCents)}</td>
                <td className="px-3 py-2 text-right">{formatEuro(l.discountCents)}</td><td className="px-3 py-2 text-right">{formatEuro(l.netCents)}</td>
                <td className="px-3 py-2 text-right">{pct(l.vatRateBp)}</td><td className="px-3 py-2 text-right">{formatEuro(l.vatCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="grid gap-1 p-4 text-sm tabular-nums sm:max-w-md">
        <p className="flex justify-between"><span>Sous-total HT</span><span>{formatEuro(o.subtotalCents)}</span></p>
        <p className="flex justify-between"><span>Promotion {o.promotionCode ? `${o.promotionCode} (${pct(o.promotionPercentBp)})` : "—"}</span><span>{formatEuro(-o.discountCents)}</span></p>
        <p className="flex justify-between font-medium"><span>Total HT</span><span>{formatEuro(o.totalHTCents)}</span></p>
        <p className="flex justify-between"><span>TVA</span><span>{formatEuro(o.totalVATCents)}</span></p>
        <p className="flex justify-between font-semibold text-slate-900"><span>Total TTC</span><span>{formatEuro(o.totalTTCCents)}</span></p>
        <p className="pt-1 text-xs text-slate-500">Remise appliquée ligne par ligne sur le HT ; TVA par ligne après remise ; arrondis au centime (demi supérieur).</p>
      </CardContent></Card>

      <Card><CardContent className="p-4 text-sm">
        {conversion
          ? <p>Attribuée à la campagne « {conversion.campaign.name} » le {fmtInstant(conversion.createdAt)} · montant HT net attribué {formatEuro(conversion.attributedHTCents)}.</p>
          : <p className="text-slate-500">Aucune attribution marketing. <a href="/marketing" className="text-[#0f3460] underline">Attribuer depuis l&apos;écran Marketing</a> (consentement du client requis).</p>}
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
