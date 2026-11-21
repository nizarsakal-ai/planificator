// Lot F Planificator V2 : centre de connecteurs. Connecteurs externes en catalogue fermé (dix depuis la v4), chacun DÉSACTIVÉ ou en
// SIMULATION (double fictif, sans réseau) ; LOT-8B : Shopify, Mailchimp et Slack aussi en connexion réelle en lecture seule
// (drapeau CONNECTOR_LIVE_ENABLED, identifiants chiffrés dans le coffre, jamais réaffichés). Les connexions
// de la plateforme d'intégration existante sont affichées en lecture seule (type, nom, états ; jamais d'identifiant).
// Drapeau CONNECTOR_CENTER_ENABLED + ADMIN/SUPER_ADMIN.
import { PlugZap } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { connectorPageAccess } from "@/lib/connectors/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { CATEGORY_LABEL, isConnectorKey } from "@/lib/connectors/catalog"
import { SYNC_ERROR_CODES, SYNC_ERROR_LABEL, type SyncErrorCode } from "@/lib/connectors/connectors.core"
import { listStagedRecords, loadConnectorCenter } from "@/lib/connectors/queries"
import { configureLiveConnectorAction, resetConnectorWatermarkAction, revokeLiveConnectorAction, setConnectorModeAction, syncConnectorAction } from "@/lib/actions/connector.actions"
import { isConnectorLiveEnabled } from "@/lib/connectors/connector-feature-flag"
import { isLiveConnectorKey } from "@/lib/connectors/connectors.core"
import { LIVE_FIELDS } from "@/lib/integration/connectors/live/live-catalog"
import { loadLiveStatus } from "@/lib/integration/connectors/live/live-connection.service"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { StockFlash } from "@/components/stock/StockFlash"
// v3 (recette Chrome F v2) : retour explicite qualifié E4 (verrou d'envoi, erreur sur place, navigation native après succès).
import { FormulaireRetour, MessageRetour, ZoneRetour } from "@/components/crm/RetourFormulaire"
import { fmtInstant } from "@/components/equipment/labels"

// Code hors liste (impossible en base) : libellé générique, jamais la valeur brute.
const errorLabel = (c: string | null) => (c === null ? "" : (SYNC_ERROR_CODES as readonly string[]).includes(c) ? SYNC_ERROR_LABEL[c as SyncErrorCode] : SYNC_ERROR_LABEL.INTERNAL_ERROR)

export default async function ConnectorCenterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await connectorPageAccess()
  // Rôle ou société non habilités : refus rendu sur place, avant toute lecture métier (modèle des lots A, B et E).
  if (!ctx) return <AdminOnlyNotice />
  const params = await searchParams
  const { connectors, platform } = await loadConnectorCenter(prisma, ctx.companyId)
  // LOT-8B : état des identifiants (indice et configuration non secrète seulement), si le drapeau est actif.
  const liveEnabled = isConnectorLiveEnabled()
  const live = liveEnabled ? await loadLiveStatus(prisma, ctx.companyId) : null
  const preview = typeof params.apercu === "string" && isConnectorKey(params.apercu) ? params.apercu : null
  const records = preview ? await listStagedRecords(prisma, ctx.companyId, preview) : []

  return (
    <ZoneRetour rendu={Date.now()}>
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><PlugZap className="h-6 w-6 text-[#0f3460]" /> Centre de connecteurs</h1>
        <p className="mt-1 text-sm text-slate-500">Services externes (commerce, paiement, marketing, messagerie, ChatGPT, agenda, e-mail, documents). Chacun peut être testé avec des données fictives{liveEnabled ? " ; Shopify, Mailchimp et Slack peuvent aussi être branchés pour de vrai, en lecture seule" : ""}. Les données reçues sont mises de côté sans toucher à vos données.</p>
      </div>
      <MessageRetour><StockFlash params={params} /></MessageRetour>
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        En simulation, les données affichées sont <strong>fictives</strong>, générées par Planificator lui-même, sans contacter le service.{liveEnabled ? " En connexion réelle, Planificator lit le service avec vos identifiants, chiffrés, sans jamais rien y écrire ni envoyer." : " Brancher un service pour de vrai demandera votre accord, ses identifiants et une version dédiée."}
      </p>

      <div className="grid gap-3 lg:grid-cols-2">
        {connectors.map((c) => {
          const ls = live && isLiveConnectorKey(c.def.key) ? live[c.def.key] : null
          const fields = ls && isLiveConnectorKey(c.def.key) ? LIVE_FIELDS[c.def.key] : []
          const badge = c.mode === "LIVE" ? ["Connexion réelle", "bg-emerald-50 text-emerald-700"] : c.mode === "SIMULATION" ? ["Simulation", "bg-amber-50 text-amber-700"] : ["Désactivé", "bg-slate-100 text-slate-700"]
          return (
          <Card key={c.def.key}><CardContent className="space-y-3 p-4">
            {/* Badge d'état toujours en haut à droite : le bloc de texte se réduit, le badge ne passe jamais à la ligne. */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-slate-900">{c.def.label} <span className="text-xs font-normal text-slate-500">· {CATEGORY_LABEL[c.def.category]}</span></h2>
                <p className="text-xs text-slate-500">{c.def.description}</p>
              </div>
              <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${badge[1]}`}>{badge[0]}</span>
            </div>
            {ls ? (
              <div className="space-y-2 rounded-md border border-slate-200 p-2">
                <p className="text-xs text-slate-600">Connexion réelle (lecture seule) : {ls.usable ? <strong>identifiants vérifiés{ls.hint ? `, se terminant par ${ls.hint}` : ""}</strong> : ls.configured ? <strong>identifiants à renouveler ({ls.credentialStatus === "REVOKED" ? "révoqués" : "non valides"})</strong> : <strong>aucun identifiant enregistré</strong>}{Object.keys(ls.config).length > 0 ? ` · ${Object.values(ls.config).join(" · ")}` : ""}.</p>
                <details>
                  <summary className="cursor-pointer text-xs text-[#0f3460] underline">{ls.usable ? "Remplacer les identifiants" : "Enregistrer les identifiants"}</summary>
                  <FormulaireRetour action={configureLiveConnectorAction} className="mt-2 space-y-2"><input type="hidden" name="connectorKey" value={c.def.key} />
                    {fields.map((f) => (
                      <label key={f.name} className="block text-xs text-slate-700">{f.label}
                        <input name={f.name} type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} required placeholder={f.placeholder} defaultValue={f.secret ? undefined : ls.config[f.name]} className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs" />
                        <span className="text-[11px] text-slate-500">{f.help}</span>
                      </label>
                    ))}
                    <Button type="submit" size="sm" variant="outline">Vérifier et enregistrer</Button>
                  </FormulaireRetour>
                </details>
                {ls.configured && ls.credentialStatus === "ACTIVE" && (
                  <FormulaireRetour action={revokeLiveConnectorAction} className="flex items-center gap-1"><input type="hidden" name="connectorKey" value={c.def.key} />
                    <Button type="submit" size="sm" variant="outline">Révoquer les identifiants</Button>
                    <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="confirm" value="oui" required /> Je confirme</label>
                  </FormulaireRetour>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Connexion réelle : <strong>pas encore disponible</strong> (nécessitera : {c.def.credentialsRequired.join(", ")}). Aucun identifiant enregistré.</p>
            )}
            <p className="text-xs text-slate-600">Données {c.mode === "LIVE" ? "" : "fictives "}reçues : {c.def.resources.map((r) => `${r.label} ${c.staged[r.key] ?? 0}`).join(" · ")}{c.hasWatermark ? " · reprise à partir de la dernière synchronisation" : ""}</p>
            <div className="flex flex-wrap items-center gap-2">
              <FormulaireRetour action={setConnectorModeAction}><input type="hidden" name="connectorKey" value={c.def.key} /><input type="hidden" name="mode" value={c.mode === "DISABLED" ? "SIMULATION" : "DISABLED"} />
                <Button type="submit" size="sm" variant="outline">{c.mode === "DISABLED" ? "Activer la simulation" : "Désactiver"}</Button>
              </FormulaireRetour>
              {ls?.usable && c.mode !== "LIVE" && (
                <FormulaireRetour action={setConnectorModeAction}><input type="hidden" name="connectorKey" value={c.def.key} /><input type="hidden" name="mode" value="LIVE" />
                  <Button type="submit" size="sm" variant="outline">Utiliser la connexion réelle</Button>
                </FormulaireRetour>
              )}
              {c.mode !== "DISABLED" && (
                <>
                  <FormulaireRetour action={syncConnectorAction}><input type="hidden" name="connectorKey" value={c.def.key} /><Button type="submit" size="sm">{c.mode === "LIVE" ? "Synchroniser" : "Synchroniser (simulation)"}</Button></FormulaireRetour>
                  <FormulaireRetour action={resetConnectorWatermarkAction} className="flex items-center gap-1"><input type="hidden" name="connectorKey" value={c.def.key} />
                    <Button type="submit" size="sm" variant="outline">Tout resynchroniser depuis le début</Button>
                    <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" name="confirm" value="oui" required /> Je confirme</label>
                  </FormulaireRetour>
                </>
              )}
              {/* v5 (recette Chrome v4) : lien HTML natif, navigation du document (la transition client next/link ne se terminait pas). */}
              <a href={`/connecteurs?apercu=${c.def.key}`} className="text-xs text-[#0f3460] underline">Aperçu des données reçues</a>
            </div>
            {c.runs.length > 0 && (
              <ul className="space-y-1 text-xs text-slate-600">
                {c.runs.map((r) => (
                  <li key={r.id}>{fmtInstant(r.startedAt)} · {r.status === "SUCCEEDED" ? `Réussie : ${r.received} reçu(s), ${r.created} nouveau(x), ${r.updated} modifié(s), ${r.unchanged} inchangé(s)` : `Échec : ${errorLabel(r.errorCode)}`}</li>
                ))}
              </ul>
            )}
          </CardContent></Card>
          )
        })}
      </div>

      {preview && (
        <Card><CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Données reçues{connectors.find((c) => c.def.key === preview)?.mode === "LIVE" ? "" : " (fictives)"} — {connectors.find((c) => c.def.key === preview)?.def.label}</caption>
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Ressource</th><th scope="col" className="px-3 py-2">Identifiant externe</th><th scope="col" className="px-3 py-2">Version</th><th scope="col" className="px-3 py-2">Contenu</th></tr></thead>
            <tbody>
              {records.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">Aucune donnée reçue.</td></tr>}
              {records.map((r) => <tr key={r.id} className="border-t align-top"><td className="px-3 py-2">{r.resource}</td><td className="px-3 py-2 font-mono text-xs">{r.externalId}</td><td className="px-3 py-2">{r.version}</td><td className="px-3 py-2 font-mono text-xs break-all">{JSON.stringify(r.payload)}</td></tr>)}
            </tbody>
          </table>
        </CardContent></Card>
      )}

      <Card><CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">Plateforme d&apos;intégration existante (lecture seule)</caption>
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th scope="col" className="px-3 py-2">Connexion</th><th scope="col" className="px-3 py-2">État</th><th scope="col" className="px-3 py-2">Identifiants</th><th scope="col" className="px-3 py-2">Santé</th><th scope="col" className="px-3 py-2">Dernier succès</th></tr></thead>
          <tbody>
            {platform.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">Aucune connexion de plateforme.</td></tr>}
            {platform.map((p) => <tr key={p.id} className="border-t"><td className="px-3 py-2">{p.displayName} <span className="text-xs text-slate-500">({p.connectorType})</span></td><td className="px-3 py-2">{p.status}</td><td className="px-3 py-2">{p.credentialStatus}</td><td className="px-3 py-2">{p.runtimeHealth}</td><td className="px-3 py-2">{p.lastSuccessfulRunAt ? fmtInstant(p.lastSuccessfulRunAt) : "—"}</td></tr>)}
          </tbody>
        </table>
      </CardContent></Card>
    </div>
    </ZoneRetour>
  )
}
