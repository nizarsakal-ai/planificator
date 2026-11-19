// Lot I Planificator V2 : Boutique — commandes internes de SIMULATION sur données fictives et promotions. Aucun
// paiement, aucune facture, aucun devis, aucun mouvement de stock, aucun parcours d'achat public. Les prix, taux et
// libellés sont figés depuis l'article au moment de la commande ; le formulaire ne transmet jamais de prix.
// Drapeau MARKETING_SHOP_ENABLED + ADMIN/SUPER_ADMIN. Refus rendu sur place avant toute lecture (AdminOnlyNotice),
// retour explicite E4 (ZoneRetour, MessageRetour, FormulaireRetour), liens HTML natifs vers les fiches de commande.
import { randomUUID } from "node:crypto"
import { Store } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { marketingShopPageAccess } from "@/lib/marketing-shop/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getShopView } from "@/lib/marketing-shop/queries"
import { promotionState } from "@/lib/marketing-shop/shop.core"
import { createOrderAction, createPromotionAction, setPromotionActiveAction } from "@/lib/actions/marketing-shop.actions"
import { formatDay, parisToday } from "@/lib/equipment/equipment.core"
import { bpToPercentString, decimalToCents, formatEuro } from "@/lib/billing/money"
import { serverNow } from "@/lib/billing/clock"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { SELECT_CLASS, StockFlash } from "@/components/stock/StockFlash"
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

/** Lignes proposées par le formulaire (le serveur en accepte jusqu'à 20). */
const LINE_SLOTS = [1, 2, 3, 4, 5] as const
const STATE_LABEL = { VALID: "Valable aujourd'hui", INACTIVE: "Inactive", NOT_YET: "Pas encore valable", EXPIRED: "Expirée" } as const

export default async function BoutiquePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await marketingShopPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A et B).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const v = await getShopView(prisma, ctx.companyId)
  const today = parisToday(serverNow())
  // Clé idempotente propre à ce formulaire : un renvoi (double clic, nouvelle tentative) ne crée jamais de doublon.
  const idempotencyKey = randomUUID()

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Store className="h-6 w-6 text-[#0f3460]" /> Boutique</h1>
        <p className="mt-1 text-sm text-slate-500">Commandes internes de simulation · prix figés depuis le catalogue · promotions</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Simulation interne sur données fictives : aucun paiement, aucune facture, aucun devis, aucun mouvement de stock, aucun parcours d&apos;achat public.
      </p>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Nouvelle commande de simulation</h2>
        {v.clients.length === 0 || v.articles.length === 0 ? <p className="text-sm text-slate-400">{v.clients.length === 0 ? "Aucun client actif." : "Aucun article actif dans le catalogue."}</p> : (
          <FormulaireRetour action={createOrderAction} className="grid gap-2">
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <select name="clientId" required defaultValue="" className={SELECT_CLASS} aria-label="Client"><option value="" disabled>Client…</option>{v.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            {LINE_SLOTS.map((i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                <select name={`articleId_${i}`} required={i === 1} defaultValue="" className={SELECT_CLASS} aria-label={`Article, ligne ${i}`}>
                  <option value="">{i === 1 ? "Article…" : "Article (facultatif)…"}</option>
                  {v.articles.map((a) => <option key={a.id} value={a.id}>{a.designation} · {formatEuro(decimalToCents(a.unitPrice))} HT / {a.unit} · TVA {a.vatRate.toFixed(2).replace(".", ",")} %</option>)}
                </select>
                <Input name={`quantity_${i}`} type="number" min={1} max={999} step={1} inputMode="numeric" required={i === 1} placeholder="Quantité" aria-label={`Quantité, ligne ${i}`} />
              </div>
            ))}
            <Input name="promoCode" maxLength={32} placeholder="Code promotionnel (facultatif)" aria-label="Code promotionnel" className="sm:max-w-xs" />
            <p className="text-xs text-slate-500">Quantités entières de 1 à 999. Prix HT, TVA et libellés repris de l&apos;article au moment de l&apos;enregistrement ; remise de la promotion appliquée ligne par ligne sur le HT, TVA calculée par ligne après remise, arrondis au centime.</p>
            <div><Button type="submit">Enregistrer la commande</Button></div>
          </FormulaireRetour>
        )}
      </CardContent></Card>

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Commandes de simulation</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Date</th><th scope="col" className="px-3 py-2">Client</th><th scope="col" className="px-3 py-2 text-right">Lignes</th><th scope="col" className="px-3 py-2">Promotion</th><th scope="col" className="px-3 py-2 text-right">Total HT</th><th scope="col" className="px-3 py-2 text-right">Total TTC</th></tr></thead>
          <tbody>
            {v.orders.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Aucune commande.</td></tr>}
            {v.orders.map((o) => (
              <tr key={o.id} className="border-t tabular-nums">
                <td className="px-3 py-2"><a href={`/boutique/commandes/${o.id}`} className="text-[#0f3460] underline">{fmtInstant(o.createdAt)}</a></td>
                <td className="px-3 py-2">{o.client.name}</td><td className="px-3 py-2 text-right">{o._count.lines}</td><td className="px-3 py-2">{o.promotionCode ?? "—"}</td>
                <td className="px-3 py-2 text-right">{formatEuro(o.totalHTCents)}</td><td className="px-3 py-2 text-right">{formatEuro(o.totalTTCCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Promotions</h2>
        <FormulaireRetour action={createPromotionAction} className="grid gap-2 sm:grid-cols-5">
          <Input name="code" required minLength={3} maxLength={32} placeholder="Code (ex. PRINTEMPS-10)" aria-label="Code promotionnel" />
          <Input name="percent" required inputMode="decimal" maxLength={6} placeholder="Remise (%)" aria-label="Remise en pourcentage" />
          <label className="grid gap-1 text-xs text-slate-600">Valable du<Input name="validFrom" type="date" required aria-label="Premier jour de validité" /></label>
          <label className="grid gap-1 text-xs text-slate-600">au<Input name="validUntil" type="date" required aria-label="Dernier jour de validité" /></label>
          <div className="self-end"><Button type="submit">Créer la promotion</Button></div>
        </FormulaireRetour>
        <p className="text-xs text-slate-500">Code normalisé en majuscules (lettres, chiffres, tirets). Une promotion par commande. Fenêtre en jours civils, bornes incluses. Le code, le taux et la fenêtre sont figés ; seul l&apos;état actif peut changer.</p>
        {v.promotions.length === 0 ? <p className="text-sm text-slate-400">Aucune promotion.</p> : (
          <ul className="space-y-1 text-sm">{v.promotions.map((p) => {
            const state = promotionState(p, today)
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{p.code}</span> · {bpToPercentString(p.percentBp).replace(".", ",")} % · du {formatDay(p.validFrom)} au {formatDay(p.validUntil)} · <span className={state === "VALID" ? "text-green-700" : "text-slate-500"}>{STATE_LABEL[state]}</span>
                <FormulaireRetour action={setPromotionActiveAction}>
                  <input type="hidden" name="promotionId" value={p.id} /><input type="hidden" name="active" value={p.active ? "non" : "oui"} />
                  <Button type="submit" size="sm" variant="outline">{p.active ? "Désactiver" : "Activer"}</Button>
                </FormulaireRetour>
              </li>
            )
          })}</ul>
        )}
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
