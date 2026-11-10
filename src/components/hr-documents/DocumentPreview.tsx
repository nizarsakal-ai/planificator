"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetchHrDocument, type HrDownload } from "@/lib/hr-documents/download-client"
import { PdfCanvasPreview } from "@/components/hr-documents/PdfCanvasPreview"

/**
 * Aperçu privé d'un document RH dans une fenêtre interne. Les octets viennent de fetchHrDocument (même route, mêmes
 * droits, même contrôle MIME et session) ; aucun lien public, aucun lecteur externe, aucun enregistrement sans clic
 * explicite sur « Télécharger ». Visualiser ne modifie aucun statut : la route de téléchargement est en lecture seule.
 * r1 : les PDF ne passent plus par un cadre ni par le lecteur du navigateur (aperçu blanc dans les navigateurs intégrés,
 * téléchargement implicite sans lecteur) ; ils sont rendus en <canvas> par PdfCanvasPreview, sans URL ni réseau.
 */
export const PREVIEWABLE_MIME = ["application/pdf", "image/jpeg", "image/png"] as const
export const PREVIEW_MESSAGES = {
  unsupported: "Ce format (HEIC) ne peut pas être affiché dans le navigateur. Utilisez « Télécharger » pour l’ouvrir sur votre appareil.",
  unavailable: "Aperçu indisponible.",
  imageFailed: "Cette image ne peut pas être affichée dans le navigateur. Utilisez « Télécharger » pour l’ouvrir sur votre appareil.",
} as const

export type PreviewTarget = { id: string; title: string }
export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; id: string; title: string }
  /** url : image seulement (blob révocable) ; pdf : octets validés rendus en canvas, sans URL ; HEIC : ni l'un ni l'autre. */
  | { status: "ready"; id: string; title: string; url: string | null; pdf: Blob | null; name: string; mime: HrDownload["mime"] }
  | { status: "error"; id: string; title: string; message: string }
export type ObjectUrls = { create: (blob: Blob) => string; revoke: (url: string) => void }
type FetchDocument = (id: string) => Promise<HrDownload>

const browserUrls: ObjectUrls = { create: blob => URL.createObjectURL(blob), revoke: url => URL.revokeObjectURL(url) }

/** Enregistrement d'un blob déjà validé ; appelé uniquement sur action explicite de l'utilisateur. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a")
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Logique de l'aperçu, sans DOM : une seule requête utile à la fois (jeton), réponse tardive ignorée sans créer d'URL,
 * double ouverture du même document sans second appel, URL blob révoquée à la fermeture, au changement et au démontage.
 */
export function createPreviewSession({ fetchDocument = fetchHrDocument, urls = browserUrls, onChange }: {
  fetchDocument?: FetchDocument; urls?: ObjectUrls; onChange: (state: PreviewState) => void
}) {
  let state: PreviewState = { status: "idle" }, request = 0, current: HrDownload | null = null
  const set = (next: PreviewState) => { state = next; onChange(next) }
  const release = () => { if (state.status === "ready" && state.url) urls.revoke(state.url); current = null }
  return {
    get state() { return state },
    async open(target: PreviewTarget) {
      if ((state.status === "loading" || state.status === "ready") && state.id === target.id) return
      const token = ++request
      release(); set({ status: "loading", ...target })
      let doc: HrDownload
      try { doc = await fetchDocument(target.id) } catch (e) {
        if (token === request) set({ status: "error", ...target, message: e instanceof Error && e.message ? e.message : PREVIEW_MESSAGES.unavailable })
        return
      }
      if (token !== request) return
      const previewable = (PREVIEWABLE_MIME as readonly string[]).includes(doc.mime)
      const isPdf = doc.mime === "application/pdf"
      // Type imposé par le contrôle MIME : le blob ne peut pas être interprété comme une page HTML. Aucune URL pour un PDF.
      const url = previewable && !isPdf ? urls.create(new Blob([doc.blob], { type: doc.mime })) : null
      const pdf = isPdf ? new Blob([doc.blob], { type: "application/pdf" }) : null
      current = doc
      set({ status: "ready", ...target, url, pdf, name: doc.name, mime: doc.mime })
    },
    close() { request++; release(); if (state.status !== "idle") set({ status: "idle" }) },
    download(save: (blob: Blob, name: string) => void = saveBlob) {
      if (state.status !== "ready" || !current) return false
      save(current.blob, current.name); return true
    },
  }
}

const button = "rounded-lg border border-blue-200 px-3 py-2 text-sm text-blue-900 disabled:opacity-50"
const notice = "rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950"

/**
 * Sans DialogTrigger, Radix ne connaît pas le bouton d'origine : le focus est rendu explicitement au bouton
 * « Visualiser » mémorisé, s'il est encore dans la page ; sinon le comportement par défaut de Radix s'applique.
 */
export function restoreFocus(event: { preventDefault: () => void }, element: HTMLElement | null | undefined) {
  if (!element || !element.isConnected) return false
  event.preventDefault(); element.focus(); return true
}

/** Image validée mais non décodable : message de repli au lieu d'une image cassée. */
function PreviewImage({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <p role="status" className={notice}>{PREVIEW_MESSAGES.imageFailed}</p>
  return <img src={url} alt={`Aperçu de ${title}`} onError={() => setFailed(true)} className="mx-auto max-h-[70vh] w-auto rounded-lg border border-slate-200 object-contain"/>
}

/** Contenu de la fenêtre selon l'état de la session : rendu testable hors navigateur. */
export function PreviewBody({ state }: { state: PreviewState }) {
  if (state.status === "loading") return <p role="status" className="py-6 text-sm text-slate-600">Chargement de l’aperçu…</p>
  if (state.status === "error") return <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.message}</p>
  if (state.status !== "ready") return null
  // PDF : rendu canvas local, indépendant du lecteur PDF du navigateur ; aucun cadre, aucune URL, aucun téléchargement.
  if (state.mime === "application/pdf" && state.pdf) return <PdfCanvasPreview key={state.id} blob={state.pdf} title={state.title}/>
  if (!state.url) return <p role="status" className={notice}>{PREVIEW_MESSAGES.unsupported}</p>
  return <PreviewImage key={state.url} url={state.url} title={state.title}/>
}

export function DocumentPreview({ target, onClose, returnFocus }: { target: PreviewTarget | null; onClose: () => void; returnFocus?: RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<PreviewState>({ status: "idle" })
  const session = useRef<ReturnType<typeof createPreviewSession> | null>(null)
  session.current ??= createPreviewSession({ onChange: setState })
  const targetId = target?.id, targetTitle = target?.title
  useEffect(() => {
    const s = session.current!
    if (targetId) void s.open({ id: targetId, title: targetTitle ?? "" })
    else s.close()
  }, [targetId, targetTitle])
  useEffect(() => () => session.current?.close(), [])
  const title = state.status === "idle" ? target?.title ?? "" : state.title
  return <Dialog open={target !== null} onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="max-h-[95vh] max-w-4xl overflow-y-auto" onCloseAutoFocus={event => { restoreFocus(event, returnFocus?.current) }}>
      <DialogHeader>
        <DialogTitle className="break-words pr-8">{title}</DialogTitle>
        <DialogDescription>Aperçu privé, aucun téléchargement automatique. Le fichier n’est téléchargé que sur clic sur « Télécharger ».</DialogDescription>
      </DialogHeader>
      <PreviewBody state={state}/>
      <DialogFooter className="gap-2">
        <button type="button" className={button} onClick={onClose}>Fermer</button>
        <button type="button" className={button} disabled={state.status !== "ready"} onClick={() => { session.current?.download() }}>Télécharger</button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
