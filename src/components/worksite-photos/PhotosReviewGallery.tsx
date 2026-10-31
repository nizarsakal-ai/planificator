"use client"

import { useRef, useState } from "react"
import { CheckCircle2, Clock, Loader2, RotateCcw, Send, ShieldCheck, Trash2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import type { ReviewItem } from "@/lib/worksite-photos/photo-review.service"

/**
 * Galerie de contrôle SUPER_ADMIN (LOT-ADMIN-REVIEW) — UI sans logique métier : le serveur relit l'autorité et décide.
 * Deux dimensions affichées séparément : « Validation interne » et « Envoi au client ». Valider n'envoie rien.
 * Suppression = corbeille Google Drive (récupérable, jamais définitive), avec reprise visible après panne.
 */
export type { ReviewItem }
export interface ReviewPage { photos: ReviewItem[]; nextCursor: string | null }

const FILTERS = [
  { value: "ALL", label: "Toutes" },
  { value: "TO_REVIEW", label: "À valider" },
  { value: "APPROVED", label: "Validées" },
  { value: "SENT", label: "Envoyées" },
  { value: "TO_RESUME", label: "Suppression à reprendre" },
  { value: "REMOVED", label: "Supprimées" },
] as const
type FilterValue = (typeof FILTERS)[number]["value"]

const PAGE_SIZE = 24

const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "")
const phaseLabel = (p: ReviewItem["phase"]) => (p === "BEFORE" ? "Avant" : "Après")

/** Libellé de la validation interne (dimension 1). */
export function approvalText(photo: ReviewItem): string {
  switch (photo.approval.state) {
    case "APPROVED": return `Validée par ${photo.approval.byName ?? "—"} le ${fmt(photo.approval.at)}`
    case "TO_REVIEW": return "À valider"
    case "NOT_APPROVED": return "Non validée"
    case "NOT_TRACKED": return "Non tracée (antérieure au contrôle)"
  }
}

/** Libellé de l'envoi au client (dimension 2) : « envoyée » seulement avec une preuve de transport enregistrée. */
export function deliveryText(photo: ReviewItem): string {
  return photo.delivery.state === "SENT"
    ? `Envoyée le ${fmt(photo.delivery.sentAt)} (preuve de transport enregistrée)`
    : "Non envoyée : aucun envoi automatique n'est actif, valider ne transmet rien au client"
}

function deletionText(photo: ReviewItem): string | null {
  const d = photo.deletion
  if (d.state === "TO_RESUME") return `Suppression demandée par ${d.byName ?? "—"} le ${fmt(d.requestedAt)}, inachevée : reprenez-la.`
  if (d.state === "TRASHED") {
    return d.path === "REJECT"
      ? `Supprimée avant envoi le ${fmt(d.doneAt)} (corbeille Google Drive).`
      : `Supprimée après envoi le ${fmt(d.doneAt)} (corbeille Google Drive) ; la preuve d'envoi est conservée.`
  }
  return null
}

function Badges({ photo }: { photo: ReviewItem }) {
  const approval = photo.approval.state
  return (
    <div className="flex flex-wrap gap-1">
      <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${approval === "APPROVED" ? "bg-green-50 text-green-800 border-green-100" : approval === "TO_REVIEW" ? "bg-amber-50 text-amber-800 border-amber-100" : "bg-slate-50 text-slate-500 border-slate-200"}`}>
        {approval === "APPROVED" ? <ShieldCheck className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
        {approval === "APPROVED" ? "Validée" : approval === "TO_REVIEW" ? "À valider" : approval === "NOT_APPROVED" ? "Non validée" : "Validation non tracée"}
      </span>
      <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${photo.delivery.state === "SENT" ? "bg-blue-50 text-blue-800 border-blue-100" : "bg-slate-50 text-slate-600 border-slate-200"}`}>
        <Send className="h-3 w-3" /> {photo.delivery.state === "SENT" ? "Envoyée" : "Non envoyée"}
      </span>
      {photo.deletion.state === "TO_RESUME" && (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] text-red-800"><TriangleAlert className="h-3 w-3" /> Suppression à reprendre</span>
      )}
      {photo.deletion.state === "TRASHED" && (
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"><Trash2 className="h-3 w-3" /> {photo.deletion.path === "REJECT" ? "Supprimée avant envoi" : "Supprimée après envoi"}</span>
      )}
    </div>
  )
}

/** Commandes disponibles selon l'état (le serveur reste seul juge ; ceci n'évite que des clics inutiles). */
export function actionsFor(photo: ReviewItem): { approve: boolean; trash: boolean; resume: boolean } {
  return {
    approve: photo.approval.state === "TO_REVIEW" && photo.deletion.state === "NONE",
    trash: photo.deletion.state === "NONE" && (photo.status === "PENDING" || photo.status === "SENT"),
    resume: photo.deletion.state === "TO_RESUME",
  }
}

/**
 * Admission d'une action : jamais pendant une lecture (chargement, « Charger plus », actualisation) ni pendant une autre
 * action. `inFlight` est le verrou synchrone (référence) qui couvre le double appui avant le rendu suivant.
 */
export function canStartMutation(state: { loading: boolean; busy: "approve" | "trash" | null; inFlight: boolean }): boolean {
  return !state.loading && state.busy === null && !state.inFlight
}

export interface PhotoReviewDetailProps {
  photo: ReviewItem
  busy: "approve" | "trash" | null
  /** Verrou global (lecture ou action en cours) : toutes les commandes sont désactivées, sans indicateur trompeur. */
  locked?: boolean
  confirming: boolean
  onApprove: () => void
  onAskTrash: () => void
  onConfirmTrash: () => void
  onCancelTrash: () => void
}

/** Détail d'une photo : aperçu privé agrandi (proxy authentifié), deux dimensions, actions selon l'état. */
export function PhotoReviewDetail({ photo, busy, locked = false, confirming, onApprove, onAskTrash, onConfirmTrash, onCancelTrash }: PhotoReviewDetailProps) {
  const disabled = locked || busy !== null
  const trashed = photo.deletion.state === "TRASHED"
  const { approve: canApprove, trash: canTrash, resume: canResume } = actionsFor(photo)
  const deletion = deletionText(photo)
  return (
    <div className="space-y-4">
      {trashed ? (
        <div className="flex h-48 items-center justify-center rounded-lg bg-slate-100 text-sm text-slate-500">Photo dans la corbeille Drive</div>
      ) : (
        <img src={`/api/worksite-photos/${encodeURIComponent(photo.id)}/file`} alt={`Photo ${photo.truck.matricule} ${phaseLabel(photo.phase)}`} className="max-h-[45dvh] w-full rounded-lg bg-slate-900 object-contain sm:max-h-[60vh]" />
      )}
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Chantier</dt><dd className="text-slate-800">{photo.worksite.clientName} — {photo.worksite.name}</dd>
        <dt className="text-slate-500">Engin</dt><dd className="text-slate-800">{photo.truck.matricule} · {phaseLabel(photo.phase)}</dd>
        <dt className="text-slate-500">Prise</dt><dd className="text-slate-800">{fmt(photo.uploadedAt)} · {photo.uploadedByName}</dd>
      </dl>
      <section className="rounded-lg border border-slate-100 p-3" aria-label="Validation interne">
        <p className="text-xs font-semibold uppercase text-slate-500">Validation interne</p>
        <p className="text-sm text-slate-800">{approvalText(photo)}</p>
      </section>
      <section className="rounded-lg border border-slate-100 p-3" aria-label="Envoi au client">
        <p className="text-xs font-semibold uppercase text-slate-500">Envoi au client</p>
        <p className="text-sm text-slate-800">{deliveryText(photo)}</p>
      </section>
      {deletion && <p className={`text-sm rounded-md px-3 py-2 border ${canResume ? "text-red-800 bg-red-50 border-red-100" : "text-slate-600 bg-slate-50 border-slate-200"}`} role={canResume ? "alert" : undefined}>{deletion}</p>}
      <div className="sticky bottom-0 -mx-4 border-t border-slate-100 bg-white px-4 pb-1 pt-3 sm:-mx-6 sm:px-6">
      {confirming ? (
        <div className="space-y-2 rounded-lg border border-red-100 bg-red-50 p-3">
          <p className="text-sm text-red-900">
            {photo.status === "SENT"
              ? "Mettre cette photo déjà envoyée dans la corbeille Google Drive ? La preuve d'envoi est conservée."
              : "Mettre cette photo dans la corbeille Google Drive ? Elle sera marquée « Supprimée avant envoi » et ne pourra plus être validée ni envoyée."}
            {" "}Elle reste récupérable depuis la corbeille Drive, que Google vide au plus tard après 30 jours.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="destructive" className="h-11 w-full min-w-0 sm:flex-1" onClick={onConfirmTrash} disabled={disabled}>
              {busy === "trash" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />} Mettre à la corbeille
            </Button>
            <Button variant="outline" className="h-11 w-full min-w-0 sm:flex-1" onClick={onCancelTrash} disabled={disabled}>Annuler</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          {canApprove && (
            <Button className="h-11 w-full min-w-0 bg-green-700 hover:bg-green-800 sm:flex-1" onClick={onApprove} disabled={disabled}>
              {busy === "approve" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />} Valider
            </Button>
          )}
          {canTrash && (
            <Button variant="outline" className="h-11 w-full min-w-0 text-red-700 border-red-200 hover:bg-red-50 sm:flex-1" onClick={onAskTrash} disabled={disabled}>
              <Trash2 className="h-4 w-4 mr-1" /> Supprimer
            </Button>
          )}
          {canResume && (
            <Button variant="destructive" className="h-11 w-full min-w-0 sm:flex-1" onClick={onConfirmTrash} disabled={disabled}>
              {busy === "trash" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />} Reprendre la suppression
            </Button>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

interface Props {
  worksites: Array<{ id: string; name: string; clientName: string }>
  initialPage: ReviewPage
}

/**
 * Appartenance d'une photo au filtre affiché (miroir du filtre serveur) : après une action, une photo qui ne correspond
 * plus (validée sous « À valider », supprimée sous « Validées »…) sort de la liste au lieu d'y rester périmée.
 */
export function matchesFilter(photo: ReviewItem, filter: FilterValue, worksiteId: string): boolean {
  if (worksiteId && photo.worksite.id !== worksiteId) return false
  switch (filter) {
    case "ALL": return true
    case "TO_REVIEW": return photo.status === "PENDING" && photo.approval.state === "TO_REVIEW" && photo.deletion.state === "NONE"
    case "APPROVED": return photo.status === "PENDING" && photo.approval.state === "APPROVED" && photo.deletion.state === "NONE"
    case "SENT": return photo.status === "SENT" && photo.deletion.state === "NONE"
    case "TO_RESUME": return photo.deletion.state === "TO_RESUME"
    case "REMOVED": return photo.deletion.state === "TRASHED"
  }
}

/**
 * État du détail après une relecture consécutive à un échec : la photo relue remplace la copie affichée, la confirmation
 * initiale est FERMÉE (une intention récupérée montre aussitôt « Reprendre la suppression ») et l'alerte d'état incertain
 * disparaît ; photo absente de la page relue ⇒ copie conservée, alerte maintenue.
 */
export function detailAfterRefresh(photoId: string, photos: ReviewItem[] | null): { fresh: ReviewItem | null; confirming: false; stale: boolean } {
  const fresh = photos?.find((p) => p.id === photoId) ?? null
  return { fresh, confirming: false, stale: fresh === null }
}

export function PhotosReviewGallery({ worksites, initialPage }: Props) {
  const [worksiteId, setWorksiteId] = useState("")
  const [filter, setFilter] = useState<FilterValue>("ALL")
  const [items, setItems] = useState<ReviewItem[]>(initialPage.photos)
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Photo ouverte : copie propre (elle reste affichée même si l'action la fait sortir du filtre courant).
  const [selected, setSelected] = useState<ReviewItem | null>(null)
  const [busy, setBusy] = useState<"approve" | "trash" | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [staleId, setStaleId] = useState<string | null>(null)
  // Numéro de la dernière lecture : une réponse plus ancienne (filtre changé entre-temps) est ignorée.
  const loadSeq = useRef(0)
  // Verrou synchrone d'action : couvre le double appui avant que `busy` ne soit rendu.
  const inFlight = useRef(false)
  const locked = loading || busy !== null

  async function load(next: { worksiteId: string; filter: FilterValue; cursor: string | null }): Promise<ReviewItem[] | null> {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ filter: next.filter, limit: String(PAGE_SIZE) })
      if (next.worksiteId) params.set("worksiteId", next.worksiteId)
      if (next.cursor) params.set("cursor", next.cursor)
      const res = await fetch(`/api/worksite-photos/review?${params}`, { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as Partial<ReviewPage> & { error?: string }
      if (seq !== loadSeq.current) return null
      if (!res.ok) { setError(body.error ?? "Chargement impossible."); return null }
      const photos = body.photos ?? []
      setItems((prev) => (next.cursor ? [...prev, ...photos] : photos))
      setNextCursor(body.nextCursor ?? null)
      return photos
    } catch {
      if (seq === loadSeq.current) setError("Réseau indisponible, réessayez.")
      return null
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  function changeFilters(next: { worksiteId?: string; filter?: FilterValue }) {
    if (busy !== null || inFlight.current) return
    const w = next.worksiteId ?? worksiteId, f = next.filter ?? filter
    setWorksiteId(w); setFilter(f)
    void load({ worksiteId: w, filter: f, cursor: null })
  }

  function open(photo: ReviewItem, confirm = false) { setSelected(photo); setConfirming(confirm); setStaleId(null) }

  function applyUpdate(updated: ReviewItem) {
    setItems((prev) => (matchesFilter(updated, filter, worksiteId) ? prev.map((p) => (p.id === updated.id ? updated : p)) : prev.filter((p) => p.id !== updated.id)))
    setSelected((current) => (current && current.id === updated.id ? updated : current))
  }

  /** Après un échec (HTTP ou réseau) : relire la page pour afficher l'état réel (intention posée ⇒ « Suppression à reprendre »). */
  async function refreshAfterFailure(photoId: string) {
    setStaleId(photoId)
    const photos = await load({ worksiteId, filter, cursor: null })
    const next = detailAfterRefresh(photoId, photos)
    setConfirming(next.confirming)
    if (next.fresh) setSelected((current) => (current && current.id === photoId ? next.fresh : current))
    setStaleId(next.stale ? photoId : null)
  }

  async function mutate(kind: "approve" | "trash", photo: ReviewItem) {
    // Admission : aucune action pendant une lecture ni pendant une autre action (les lectures en vol ne sont jamais annulées ici).
    if (!canStartMutation({ loading, busy, inFlight: inFlight.current })) return
    inFlight.current = true
    setBusy(kind)
    setBusyId(photo.id)
    try {
      let res: Response
      try {
        res = await fetch(`/api/worksite-photos/${encodeURIComponent(photo.id)}/${kind}`, { method: "POST" })
      } catch {
        toast.error(kind === "trash" ? "Réseau indisponible : la suppression a pu commencer. Actualisez puis reprenez-la." : "Réseau indisponible : actualisez puis réessayez.")
        setBusy(null); setBusyId(null)
        await refreshAfterFailure(photo.id)
        return
      }
      const body = (await res.json().catch(() => ({}))) as { photo?: ReviewItem; error?: string }
      if (!res.ok || !body.photo) {
        toast.error(body.error ?? (kind === "trash" ? "Suppression inachevée : reprenez-la." : "Validation impossible."))
        setBusy(null); setBusyId(null)
        await refreshAfterFailure(photo.id)
        return
      }
      applyUpdate(body.photo)
      setConfirming(false)
      toast.success(kind === "approve" ? "Photo validée (aucun envoi au client)" : "Photo placée dans la corbeille Drive")
    } finally {
      inFlight.current = false
      setBusy(null)
      setBusyId(null)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Contrôle des photos (Super Admin)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block text-xs font-medium text-slate-600">Chantier
          <select className="mt-1 w-full rounded-md border border-slate-200 p-2 text-sm" value={worksiteId} onChange={(e) => changeFilters({ worksiteId: e.target.value })} disabled={locked}>
            <option value="">Tous les chantiers</option>
            {worksites.map((w) => <option key={w.id} value={w.id}>{w.clientName} — {w.name}</option>)}
          </select>
        </label>
        <div className="flex items-center justify-end">
          {/* Relecture manuelle (photos prises entre-temps, y compris via « Ajouter une photo ») ; aucune interrogation périodique. */}
          <Button variant="outline" size="sm" className="h-9" onClick={() => void load({ worksiteId, filter, cursor: null })} disabled={locked}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Actualiser
          </Button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="État des photos">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} onClick={() => changeFilters({ filter: f.value })} disabled={locked}
              className={`shrink-0 rounded-full border px-3 py-2 text-xs font-medium disabled:opacity-60 ${filter === f.value ? "bg-[#0f3460] text-white border-[#0f3460]" : "bg-white text-slate-700 border-slate-200"}`}>
              {f.label}
            </button>
          ))}
        </div>
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2" role="alert">
            <span className="flex-1">{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load({ worksiteId, filter, cursor: null })} disabled={locked}>Actualiser</Button>
          </div>
        )}
        {items.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">{loading ? "Chargement…" : "Aucune photo pour ces filtres."}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((p) => {
              const actions = actionsFor(p)
              const rowBusy = busyId === p.id
              return (
                <li key={p.id} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
                  <button type="button" onClick={() => open(p)} className="block w-full text-left" aria-label={`Voir la photo ${p.truck.matricule} ${phaseLabel(p.phase)}`}>
                    {p.deletion.state === "TRASHED" ? (
                      <div className="flex aspect-square items-center justify-center bg-slate-100 text-slate-400"><Trash2 className="h-6 w-6" /></div>
                    ) : (
                      <img src={`/api/worksite-photos/${encodeURIComponent(p.id)}/file`} alt="" loading="lazy" className="aspect-square w-full bg-slate-100 object-cover" />
                    )}
                    <div className="space-y-1 p-2">
                      <p className="truncate text-xs font-medium text-slate-800">{p.truck.matricule} · {phaseLabel(p.phase)}</p>
                      <p className="truncate text-[11px] text-slate-500">{p.worksite.name} · {fmt(p.uploadedAt)}</p>
                      <Badges photo={p} />
                    </div>
                  </button>
                  {/* Commandes visibles sans ouvrir la photo : empilées pleine largeur (cible 44 px) ; côte à côte seulement à partir de xl. */}
                  <div className="flex flex-col gap-1.5 border-t border-slate-100 p-2 xl:grid xl:grid-cols-2">
                    <Button variant="outline" className="h-11 w-full min-w-0 px-2 text-sm" onClick={() => open(p)}>Voir</Button>
                    {actions.approve && (
                      <Button className="h-11 w-full min-w-0 bg-green-700 px-2 text-sm hover:bg-green-800" onClick={() => void mutate("approve", p)} disabled={locked}>
                        {rowBusy && busy === "approve" ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Valider
                      </Button>
                    )}
                    {actions.trash && (
                      <Button variant="outline" className="h-11 w-full min-w-0 border-red-200 px-2 text-sm text-red-700 hover:bg-red-50" onClick={() => open(p, true)} disabled={locked}>
                        <Trash2 /> Supprimer
                      </Button>
                    )}
                    {actions.resume && (
                      <Button variant="destructive" className="h-11 w-full min-w-0 px-2 text-sm" onClick={() => void mutate("trash", p)} disabled={locked}>
                        {rowBusy && busy === "trash" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Reprendre
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {nextCursor && (
          <Button variant="outline" className="h-11 w-full" onClick={() => void load({ worksiteId, filter, cursor: nextCursor })} disabled={locked}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Charger plus
          </Button>
        )}
      </CardContent>
      <Dialog open={selected !== null} onOpenChange={(isOpen) => { if (!isOpen && busy === null) { setSelected(null); setConfirming(false); setStaleId(null) } }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-2xl overflow-y-auto p-4 pb-0 sm:p-6 sm:pb-0">
          {selected && (
            <>
              <DialogTitle className="text-base">{selected.truck.matricule} · {phaseLabel(selected.phase)}</DialogTitle>
              <DialogDescription className="sr-only">Contrôle de la photo : validation interne et suppression</DialogDescription>
              {staleId === selected.id && (
                <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">
                  <span className="flex-1">État incertain après une erreur : actualisez avant de reprendre.</span>
                  <Button size="sm" variant="outline" onClick={() => void refreshAfterFailure(selected.id)} disabled={locked}>Actualiser</Button>
                </div>
              )}
              <PhotoReviewDetail photo={selected} busy={busy} locked={locked} confirming={confirming}
                onApprove={() => void mutate("approve", selected)} onAskTrash={() => setConfirming(true)}
                onConfirmTrash={() => void mutate("trash", selected)} onCancelTrash={() => setConfirming(false)} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
