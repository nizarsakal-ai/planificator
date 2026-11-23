"use client"
// IA-4 : mode terrain du copilote — dictée et lecture à voix haute par les fonctions vocales du NAVIGATEUR (aucun
// service ajouté, rien n'est enregistré), et photo réduite dans le navigateur avant envoi.
import { useCallback, useEffect, useRef, useState } from "react"

/** Surface minimale de la reconnaissance vocale du navigateur (Chrome, Safari : préfixe webkit). */
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const DICTATION_ERRORS: Record<string, string> = {
  "not-allowed": "Micro refusé : autorisez-le dans les réglages du navigateur.",
  "service-not-allowed": "Micro refusé : autorisez-le dans les réglages du navigateur.",
  "no-speech": "Je n'ai rien entendu. Réessayez.",
  "audio-capture": "Aucun micro détecté.",
  network: "Dictée indisponible sans connexion.",
}

/** Dictée en français : `onText(texte final)` à chaque phrase reconnue ; `supported` est faux au rendu serveur. */
export function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const cb = useRef(onText)
  cb.current = onText

  useEffect(() => { setSupported(recognitionCtor() !== null) }, [])
  useEffect(() => () => rec.current?.abort(), [])

  const stop = useCallback(() => { rec.current?.stop() }, [])
  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || rec.current) return
    const r = new Ctor()
    r.lang = "fr-FR"
    r.interimResults = false
    r.continuous = false
    r.onresult = (e) => {
      let text = ""
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) text += e.results[i][0].transcript
      if (text.trim()) cb.current(text.trim())
    }
    r.onerror = (e) => setError(DICTATION_ERRORS[e.error] ?? (e.error === "aborted" ? null : "La dictée a échoué. Réessayez."))
    r.onend = () => { rec.current = null; setListening(false) }
    rec.current = r
    setError(null)
    setListening(true)
    try { r.start() } catch { rec.current = null; setListening(false); setError("La dictée a échoué. Réessayez.") }
  }, [])
  return { supported, listening, error, start, stop }
}

/** Texte lisible à voix haute : liens [libellé](/chemin) → libellé, gras retiré, puces simplifiées. */
export function speakableText(text: string): string {
  return text
    .replace(/\[([^\]\n]{1,120})\]\((\/[^)\s]{0,200})\)/g, "$1")
    .replace(/\*\*([^*\n]{1,200})\*\*/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500)
}

const SPEAK_KEY = "planificator:copilote-voix"

/** Lecture à voix haute des réponses (synthèse du navigateur), réglage mémorisé sur cet appareil. */
export function useSpeech() {
  const [supported, setSupported] = useState(false)
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const ok = typeof window !== "undefined" && "speechSynthesis" in window
    setSupported(ok)
    if (ok) setEnabled(window.localStorage.getItem(SPEAK_KEY) === "1")
  }, [])
  const toggle = useCallback(() => {
    setEnabled(prev => {
      const next = !prev
      window.localStorage.setItem(SPEAK_KEY, next ? "1" : "0")
      if (!next) window.speechSynthesis.cancel()
      return next
    })
  }, [])
  const speak = useCallback((text: string) => {
    if (!supported || !enabled) return
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(speakableText(text))
    u.lang = "fr-FR"
    window.speechSynthesis.speak(u)
  }, [supported, enabled])
  const cancel = useCallback(() => { if (supported) window.speechSynthesis.cancel() }, [supported])
  return { supported, enabled, toggle, speak, cancel }
}

export const MAX_PHOTO_SIDE = 1600
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024

export interface PreparedPhoto { mediaType: "image/jpeg"; data: string; preview: string }

/** Dimensions réduites en gardant les proportions (côté le plus long ≤ max). */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height }
  const ratio = width >= height ? max / width : max / height
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }
}

/** Photo de l'appareil ou de la galerie → JPEG réduit (1600 px, qualité 0,8), sans métadonnées (position GPS retirée). */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/")) throw new Error("Ce fichier n'est pas une image.")
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Photo trop lourde (25 Mo au plus).")
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("Format de photo non pris en charge.") })
  const { width, height } = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Photo impossible à préparer.")
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const preview = canvas.toDataURL("image/jpeg", 0.8)
  return { mediaType: "image/jpeg", data: preview.slice(preview.indexOf(",") + 1), preview }
}
