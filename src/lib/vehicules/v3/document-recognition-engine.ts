/**
 * Véhicules V3 — moteur OCR propre à la lecture des pièces : workers Tesseract distincts de ceux des documents RH.
 * À l'échéance d'une lecture, `kill()` oublie IMMÉDIATEMENT le moteur courant (la lecture suivante en charge un neuf)
 * et demande la terminaison de ses workers. Cette terminaison peut elle-même ne pas finir (chargement ou `terminate`
 * bloqués) : la promesse rendue par `kill()` ne se résout qu'à l'arrêt effectif, et l'appelant doit borner son attente
 * et compter l'arrêt comme travail non terminé tant qu'elle est pendante. Un chargement ancien qui échoue ou aboutit
 * tard ne touche jamais le moteur plus récent (il est alors terminé dès qu'il se résout). Les lectures RH de la même
 * instance ne sont jamais interrompues. Moteur libéré après une minute sans lecture.
 */
import { createOcrEngineHandle, type OcrEngine, type OcrEngineHandle } from "@/lib/hr-documents/recognition/ocr"

export type EngineFactory = () => Promise<OcrEngineHandle>

export interface VehicleOcrEngine {
  /** Moteur prêt (chargé au premier appel, puis réutilisé). */
  get(): Promise<OcrEngine>
  /**
   * Oublie le moteur courant tout de suite et arrête ses workers. Se résout quand l'arrêt est effectif (ou qu'il n'y
   * avait rien à arrêter) ; peut rester pendante si le chargement ou `terminate` ne finissent pas : à borner.
   */
  kill(): Promise<void>
  /** Tests : moteur chargé ? */
  loaded(): boolean
}

export function createVehicleOcrEngine(factory: EngineFactory = createOcrEngineHandle, idleMs = 60_000): VehicleOcrEngine {
  let handle: Promise<OcrEngineHandle> | null = null
  let idle: ReturnType<typeof setTimeout> | null = null
  const kill = async () => {
    if (idle) { clearTimeout(idle); idle = null }
    const current = handle
    handle = null
    if (!current) return
    let loadedHandle: OcrEngineHandle
    try { loadedHandle = await current } catch { return /* chargement échoué : rien à arrêter */ }
    try { await loadedHandle.terminate() } catch { /* terminaison en erreur : workers déjà perdus */ }
  }
  return {
    async get() {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => { void kill() }, idleMs)
      idle.unref?.()
      if (!handle) {
        const loading = Promise.resolve().then(factory)
        handle = loading
        // Seul le chargement encore courant est oublié en cas d'échec : jamais un moteur plus récent.
        loading.catch(() => { if (handle === loading) handle = null })
      }
      return (await handle).engine
    },
    kill,
    loaded: () => handle !== null,
  }
}

/** Moteur de l'instance pour la route de lecture des pièces. */
export const vehicleOcrEngine = createVehicleOcrEngine()
