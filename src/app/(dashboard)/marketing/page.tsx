// Lot I Planificator V2 : Marketing — LABORATOIRE INTERNE sur données fictives. Sources et campagnes, consentement
// d'attribution marketing par client, attribution explicite de commandes boutique, indicateurs par campagne et par
// source. Aucun envoi, aucun pixel, aucun prestataire. Drapeau MARKETING_SHOP_ENABLED + ADMIN/SUPER_ADMIN.
// Refus rendu sur place avant toute lecture (AdminOnlyNotice), retour explicite E4 (ZoneRetour, MessageRetour,
// FormulaireRetour), liens HTML natifs vers les fiches de commande.
import { Megaphone } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { marketingShopPageAccess } from "@/lib/marketing-shop/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { CHANNELS, CHANNEL_LABEL, type MarketingChannel } from "@/lib/marketing-shop/marketing.core"
import { getMarketingView } from "@/lib/marketing-shop/queries"
import { attributeOrderAction, createCampaignAction, createSourceAction, grantConsentAction, withdrawConsentAction } from "@/lib/actions/marketing-shop.actions"
import { formatDay } from "@/lib/equipment/equipment.core"
import { formatEuro } from "@/lib/billing/money"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

export default async function MarketingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await marketingShopPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const v = await getMarketingView(prisma, ctx.companyId)
  // v2 de revue : nom réel de la source lu avec chaque campagne (indépendant de la liste bornée des sources).
  const sourceOfCampaign = new Map(v.campaigns.map((c) => [c.id, c.source.name]))

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Megaphone className="h-6 w-6 text-[#0f3460]" /> Marketing</h1>
        <p className="mt-1 text-sm text-slate-500">Sources et campagnes · consentement d&apos;attribution · commandes boutique attribuées · indicateurs</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Laboratoire interne sur données fictives : aucun envoi, aucun pixel, aucune campagne externe ni prestataire. Le consentement porte uniquement sur l&apos;attribution marketing.
      </p>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Indicateurs par campagne</h2>
        <p className="text-xs text-slate-500">
          Commandes converties : commandes boutique attribuées explicitement à la campagne (au plus une campagne par commande). Montant HT net attribué : somme des totaux HT après promotion de ces commandes, figés au moment de l&apos;attribution. Aucun taux n&apos;est affiché : aucun dénominateur (visites, contacts, envois) n&apos;est mesuré.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Campagne</th><th scope="col" className="px-3 py-2">Source</th><th scope="col" className="px-3 py-2 text-right">Commandes converties</th><th scope="col" className="px-3 py-2 text-right">Montant HT net attribué</th></tr></thead>
            <tbody>
              {v.indicators.campaigns.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucune campagne.</td></tr>}
              {v.indicators.campaigns.map((k) => (
                <tr key={k.campaignId} className="border-t tabular-nums">
                  <td className="px-3 py-2">{k.name}</td><td className="px-3 py-2">{sourceOfCampaign.get(k.campaignId) ?? "—"}</td>
                  <td className="px-3 py-2 text-right">{k.convertedOrders}</td><td className="px-3 py-2 text-right">{formatEuro(k.attributedHTCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="pt-2 text-sm font-semibold text-slate-900">Totaux par source</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Source</th><th scope="col" className="px-3 py-2">Canal</th><th scope="col" className="px-3 py-2 text-right">Commandes converties</th><th scope="col" className="px-3 py-2 text-right">Montant HT net attribué</th></tr></thead>
            <tbody>
              {v.indicators.sources.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucune source.</td></tr>}
              {v.indicators.sources.map((s) => (
                <tr key={s.sourceId} className="border-t tabular-nums">
                  <td className="px-3 py-2">{s.name}</td><td className="px-3 py-2">{CHANNEL_LABEL[s.channel]}</td>
                  <td className="px-3 py-2 text-right">{s.convertedOrders}</td><td className="px-3 py-2 text-right">{formatEuro(s.attributedHTCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Nouvelle source</h2>
          <FormulaireRetour action={createSourceAction} className="grid gap-2 sm:grid-cols-2">
            <select name="channel" required defaultValue="" className={SELECT_CLASS} aria-label="Canal"><option value="" disabled>Canal…</option>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select>
            <Input name="name" required minLength={2} maxLength={120} placeholder="Nom de la source" aria-label="Nom de la source" />
            <div className="sm:col-span-2"><Button type="submit">Créer la source</Button></div>
          </FormulaireRetour>
        </CardContent></Card>

        <Card><CardContent className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Nouvelle campagne</h2>
          {v.sources.length === 0 ? <p className="text-sm text-slate-400">Créez d&apos;abord une source.</p> : (
            <FormulaireRetour action={createCampaignAction} className="grid gap-2 sm:grid-cols-2">
              <select name="sourceId" required defaultValue="" className={SELECT_CLASS} aria-label="Source"><option value="" disabled>Source…</option>{v.sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({CHANNEL_LABEL[s.channel as MarketingChannel]})</option>)}</select>
              <Input name="name" required minLength={2} maxLength={120} placeholder="Nom de la campagne" aria-label="Nom de la campagne" />
              <label className="grid gap-1 text-xs text-slate-600">Début (facultatif)<Input name="startsOn" type="date" aria-label="Date de début" /></label>
              <label className="grid gap-1 text-xs text-slate-600">Fin (facultative)<Input name="endsOn" type="date" aria-label="Date de fin" /></label>
              <div className="sm:col-span-2"><Button type="submit">Créer la campagne</Button></div>
            </FormulaireRetour>
          )}
          {v.campaigns.length > 0 && (
            <ul className="space-y-1 text-sm">{v.campaigns.map((c) => <li key={c.id}>{c.name} · {c.source.name}{c.startsOn ? ` · du ${formatDay(c.startsOn)}` : ""}{c.endsOn ? ` au ${formatDay(c.endsOn)}` : ""}</li>)}</ul>
          )}
        </CardContent></Card>
      </div>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Consentement d&apos;attribution marketing par client</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Client</th><th scope="col" className="px-3 py-2">État</th><th scope="col" className="px-3 py-2">Action</th></tr></thead>
          <tbody>
            {v.clients.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Aucun client actif.</td></tr>}
            {v.clients.map((c) => {
              const consent = v.consents.get(c.id)
              const granted = consent?.status === "GRANTED"
              return (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-xs">{granted ? `Accordé le ${fmtInstant(consent!.grantedAt)}` : consent ? `Retiré le ${consent.withdrawnAt ? fmtInstant(consent.withdrawnAt) : "—"}` : "Aucun consentement"}</td>
                  <td className="px-3 py-2">
                    {granted ? (
                      <FormulaireRetour action={withdrawConsentAction}><input type="hidden" name="clientId" value={c.id} /><Button type="submit" size="sm" variant="outline">Retirer</Button></FormulaireRetour>
                    ) : (
                      <FormulaireRetour action={grantConsentAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="clientId" value={c.id} />
                        <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="confirm" value="oui" required /> Accord explicite du client</label>
                        <Button type="submit" size="sm" variant="outline">Accorder</Button>
                      </FormulaireRetour>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="px-3 py-2 text-xs text-slate-500">Liste limitée aux 200 premiers clients actifs par ordre alphabétique. Le retrait bloque toute nouvelle attribution ; les attributions déjà faites restent.</p>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Attribuer une commande boutique à une campagne</h2>
        {v.openOrders.length === 0 || v.campaigns.length === 0 ? <p className="text-sm text-slate-400">{v.campaigns.length === 0 ? "Aucune campagne." : "Aucune commande boutique non attribuée."}</p> : (
          <FormulaireRetour action={attributeOrderAction} className="grid gap-2 sm:grid-cols-3">
            <select name="orderId" required defaultValue="" className={SELECT_CLASS} aria-label="Commande"><option value="" disabled>Commande…</option>{v.openOrders.map((o) => <option key={o.id} value={o.id}>{fmtInstant(o.createdAt)} · {o.client.name} · {formatEuro(o.totalHTCents)} HT</option>)}</select>
            <select name="campaignId" required defaultValue="" className={SELECT_CLASS} aria-label="Campagne"><option value="" disabled>Campagne…</option>{v.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <div><Button type="submit">Attribuer</Button></div>
          </FormulaireRetour>
        )}
        <p className="text-xs text-slate-500">Attribution refusée sans consentement en cours du client de la commande. Une commande sans consentement reste une commande ordinaire.</p>
        {v.conversions.length > 0 && (
          <ul className="space-y-1 text-sm">{v.conversions.map((x) => (
            <li key={x.id}><a href={`/boutique/commandes/${x.orderId}`} className="text-[#0f3460] underline">Attribution du {fmtInstant(x.createdAt)}</a> · {x.campaign.name} · {formatEuro(x.attributedHTCents)} HT</li>
          ))}</ul>
        )}
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
