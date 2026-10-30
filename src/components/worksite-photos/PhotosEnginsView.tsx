"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Camera, Loader2, RefreshCw, CheckCircle2, Clock, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { compressImage, PhotoCompressionError } from "@/lib/worksite-photos/client/compress-image"

/**
 * Page « Photos engins » (SPEC-WORKSITE-PHOTOS-001 §6.1, §7.1) — UI sans logique métier :
 * choisir chantier, engin, phase ; prendre la photo ; compresser ; envoyer avec une clé d'idempotence conservée
 * jusqu'au 201 (un nouvel appui réutilise la même clé) ; afficher les photos visibles et leur statut.
 * Les droits et les contrôles sont faits par le serveur.
 */
export interface PhotosContext {
  role: string
  worksites: Array<{ id: string; name: string; clientName: string; status: string }>
  trucks: Array<{ id: string; matricule: string }>
}
export interface PhotoListItem {
  id: string; worksiteId: string; truckId: string; phase: "BEFORE" | "AFTER"; status: "PENDING" | "SENT" | "DELETED"; drivePath: string
  originalFilename: string; sizeBytes: number; uploadedAt: string; uploadedByName: string; sentAt: string | null
}

interface Props { context: PhotosContext; initialPhotos: PhotoListItem[] }

type PendingUpload = { key: string; blob: Blob; sha256: string; worksiteId: string; truckId: string; phase: "BEFORE" | "AFTER"; takenAt: string; previewUrl: string }

const STATUS_LABEL: Record<PhotoListItem["status"], { label: string; className: string; icon: typeof Clock }> = {
  PENDING: { label: "En attente d'envoi", className: "bg-amber-50 text-amber-800 border-amber-100", icon: Clock },
  SENT: { label: "Envoyée au client", className: "bg-green-50 text-green-800 border-green-100", icon: Send },
  DELETED: { label: "Supprimée", className: "bg-slate-100 text-slate-500 border-slate-200", icon: Trash2 },
}

export function PhotosEnginsView({ context, initialPhotos }: Props) {
  const [worksiteId, setWorksiteId] = useState(context.worksites[0]?.id ?? "")
  const [truckId, setTruckId] = useState(context.trucks[0]?.id ?? "")
  const [phase, setPhase] = useState<"BEFORE" | "AFTER">("BEFORE")
  const [photos, setPhotos] = useState<PhotoListItem[]>(initialPhotos)
  const [pending, setPending] = useState<PendingUpload | null>(null)
  const [busy, setBusy] = useState<"compress" | "upload" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Révocation de l'aperçu : une seule fois, quand `pending` change ou disparaît.
  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.previewUrl) }, [pending])
  // La liste suit le chantier sélectionné (les photos initiales viennent du premier chantier, rendu par le serveur).
  const [listedWorksiteId, setListedWorksiteId] = useState(worksiteId)
  useEffect(() => {
    if (!worksiteId || worksiteId === listedWorksiteId) return
    let cancelled = false
    fetch(`/api/worksite-photos?worksiteId=${encodeURIComponent(worksiteId)}&limit=50`, { cache: "no-store" })
      .then(async (res) => { if (!cancelled && res.ok) { setPhotos(((await res.json()) as { photos: PhotoListItem[] }).photos); setListedWorksiteId(worksiteId) } })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [worksiteId, listedWorksiteId])

  const worksiteById = useMemo(() => new Map(context.worksites.map((w) => [w.id, w])), [context.worksites])
  const truckById = useMemo(() => new Map(context.trucks.map((t) => [t.id, t])), [context.trucks])
  const canShoot = !!worksiteId && !!truckId && !busy

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setError(null)
    setBusy("compress")
    try {
      const compressed = await compressImage(file)
      const next: PendingUpload = {
        key: crypto.randomUUID(), blob: compressed.blob, sha256: compressed.sha256Hex, worksiteId, truckId, phase,
        takenAt: new Date(file.lastModified || Date.now()).toISOString(), previewUrl: URL.createObjectURL(compressed.blob),
      }
      setPending(next)
      await send(next)
    } catch (err) {
      setError(err instanceof PhotoCompressionError && err.code === "TOO_LARGE_AFTER_COMPRESSION"
        ? "Photo trop volumineuse même compressée. Reprenez la photo." : "Impossible de lire cette photo.")
    } finally {
      setBusy(null)
    }
  }

  async function send(upload: PendingUpload) {
    setBusy("upload")
    setError(null)
    try {
      const form = new FormData()
      form.append("file", upload.blob, "photo.jpg")
      form.append("payload", JSON.stringify({ phase: upload.phase, takenAt: upload.takenAt, clientSha256: upload.sha256, worksiteId: upload.worksiteId, truckId: upload.truckId }))
      const res = await fetch(`/api/worksite-photos/worksites/${encodeURIComponent(upload.worksiteId)}/trucks/${encodeURIComponent(upload.truckId)}`, {
        method: "POST", headers: { "Idempotency-Key": upload.key }, body: form,
      })
      const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
      if (res.status === 409 && body.code === "UPLOAD_IN_PROGRESS") { setError("Envoi déjà en cours, réessayez dans un instant (même photo)."); return }
      if (res.status === 409 && body.code === "UPLOAD_ABORTED") { setError("Envoi abandonné : reprenez la photo."); setPending(null); return }
      if (!res.ok) { setError(body.error ?? "Envoi impossible, réessayez."); return }
      toast.success(res.headers.get("Idempotency-Replayed") === "true" ? "Photo déjà enregistrée" : "Photo enregistrée")
      setPending(null)
      // La photo est enregistrée : un échec du rafraîchissement ne doit pas être présenté comme un échec d'envoi.
      await refreshPhotos(upload.worksiteId).catch(() => setError("Photo enregistrée, mais la liste n'a pas pu être actualisée."))
    } catch {
      setError("Réseau indisponible : la photo est conservée, appuyez sur Réessayer.")
    } finally {
      setBusy(null)
    }
  }

  async function refreshPhotos(forWorksiteId: string) {
    const res = await fetch(`/api/worksite-photos?worksiteId=${encodeURIComponent(forWorksiteId)}&limit=50`, { cache: "no-store" })
    if (res.ok) { setPhotos(((await res.json()) as { photos: PhotoListItem[] }).photos); setListedWorksiteId(forWorksiteId) }
  }

  const fmt = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))

  return (
    <div className="space-y-4 max-w-xl">
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold flex items-center gap-2"><Camera className="h-4 w-4" /> Nouvelle photo d&apos;engin</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <label className="block text-xs font-medium text-slate-600">Chantier
            <select className="mt-1 w-full rounded-md border border-slate-200 p-2 text-sm" value={worksiteId} onChange={(e) => setWorksiteId(e.target.value)} disabled={!!busy}>
              {context.worksites.length === 0 && <option value="">Aucun chantier accessible</option>}
              {context.worksites.map((w) => <option key={w.id} value={w.id}>{w.clientName} — {w.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600">Engin
            <select className="mt-1 w-full rounded-md border border-slate-200 p-2 text-sm" value={truckId} onChange={(e) => setTruckId(e.target.value)} disabled={!!busy}>
              {context.trucks.length === 0 && <option value="">Aucun engin actif</option>}
              {context.trucks.map((t) => <option key={t.id} value={t.id}>{t.matricule}</option>)}
            </select>
          </label>
          <div className="flex gap-2" role="radiogroup" aria-label="Phase">
            {(["BEFORE", "AFTER"] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={phase === p} onClick={() => setPhase(p)} disabled={!!busy}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium ${phase === p ? "bg-[#0f3460] text-white border-[#0f3460]" : "bg-white text-slate-700 border-slate-200"}`}>
                {p === "BEFORE" ? "Avant chantier" : "Après chantier"}
              </button>
            ))}
          </div>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png" capture="environment" className="hidden" onChange={handleFile} />
          <Button className="w-full bg-[#0f3460] hover:bg-[#0a2540]" disabled={!canShoot} onClick={() => inputRef.current?.click()}>
            {busy === "compress" ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Préparation…</> : busy === "upload" ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Envoi…</> : <><Camera className="h-4 w-4 mr-2" /> Prendre la photo</>}
          </Button>
          {pending && !busy && (
            <div className="flex items-center gap-3 rounded-lg border border-amber-100 bg-amber-50 p-2">
              <img src={pending.previewUrl} alt="Photo en attente d'envoi" className="h-14 w-14 rounded object-cover" />
              <div className="flex-1 text-xs text-amber-900">Photo conservée sur l&apos;appareil, non encore enregistrée.</div>
              <Button size="sm" variant="outline" onClick={() => send(pending)}><RefreshCw className="h-3.5 w-3.5 mr-1" /> Réessayer</Button>
            </div>
          )}
          {error && <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2" role="alert">{error}</p>}
          <p className="text-[11px] text-slate-400">La photo est compressée sur l&apos;appareil puis stockée dans le dossier du chantier. Les ouvriers n&apos;ont pas accès au stockage.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm font-semibold">Photos du chantier</CardTitle></CardHeader>
        <CardContent>
          {photos.length === 0 ? (
            <p className="text-sm text-slate-400 py-6 text-center">Aucune photo pour l&apos;instant.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {photos.map((p) => {
                const status = STATUS_LABEL[p.status]
                const Icon = status.icon
                return (
                  <li key={p.id} className="flex items-center gap-3 py-2">
                    {p.status !== "DELETED" ? (
                      <img src={`/api/worksite-photos/${encodeURIComponent(p.id)}/file`} alt="" className="h-12 w-12 rounded object-cover bg-slate-100" loading="lazy" />
                    ) : <div className="h-12 w-12 rounded bg-slate-100" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate">{truckById.get(p.truckId)?.matricule ?? "Engin"} · {p.phase === "BEFORE" ? "Avant" : "Après"}</p>
                      <p className="text-xs text-slate-500 truncate">{worksiteById.get(p.worksiteId)?.name ?? ""} · {fmt(p.uploadedAt)} · {p.uploadedByName}</p>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${status.className}`}>
                      {p.status === "SENT" ? <CheckCircle2 className="h-3 w-3" /> : <Icon className="h-3 w-3" />} {status.label}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
