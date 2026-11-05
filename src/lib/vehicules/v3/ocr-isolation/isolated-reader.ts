/**
 * Véhicules V3 — lecture d'une pièce dans un processus Node enfant, tué à l'échéance.
 *
 * Garanties (dans les limites de Node et du système) :
 * - un processus neuf par lecture : aucun état, moteur ou mémoire ne survit d'une lecture à l'autre ;
 * - à l'abandon (signal) ou à l'échéance absolue du parent, SIGKILL du processus entier : couche texte PDF, extraction
 *   et décodage d'images, chargement et calcul OCR s'arrêtent, y compris en plein code natif ou WASM ;
 * - la promesse ne se résout qu'à la FIN RÉELLE du processus (événement `exit`), quelle que soit la cause (réponse,
 *   abandon, erreur après démarrage, envoi IPC en échec par exception ou par rappel) : l'appelant qui compte la
 *   lecture jusqu'à sa résolution compte exactement le calcul encore vivant, jamais un calcul fantôme ;
 * - R3.1 : démarrage raté (aucun pid : ENOENT, EAGAIN, EPERM…, ou exception de `fork`) → résolution immédiate en
 *   échec technique, sans attendre un `exit` qui peut ne jamais venir ; résolution unique, minuteries et écouteurs
 *   retirés ; une erreur tardive en double reste absorbée ;
 * - tas JavaScript borné (`--max-old-space-size`) et mémoire résidente totale surveillée par le chien de garde de
 *   l'enfant (natif et WASM compris, à l'échantillonnage près) ;
 * - environnement réduit (aucune variable du serveur, donc aucun secret) et sorties standard fermées ;
 * - réponse de l'enfant validée strictement ; toute autre issue (plantage, mémoire, mort sans réponse) = échec
 *   technique, jamais une lecture inventée.
 * Limites : le chemin de l'empaquetage doit exister et être embarqué au déploiement (voir `resolveWorkerPath`) ;
 * aucune preuve d'exécution serverless (Vercel) ; un processus bloqué dans le noyau (état D) ne meurt qu'à son retour.
 */
import { fork, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import type { DocumentKind } from "@/lib/hr-documents/domain"
import type { Reading } from "@/lib/hr-documents/recognition/ocr"
import { parseReadReply, type ReadRequest } from "./protocol"

export const DEFAULT_WORKER_RELATIVE_PATH = path.join(".vehicle-ocr-worker", "worker.cjs")

/** Empaquetage du processus de lecture : `VEHICLE_OCR_WORKER_PATH` (absolu) ou `<cwd>/.vehicle-ocr-worker/worker.cjs`. */
export function resolveWorkerPath(env: Partial<Record<string, string | undefined>> = process.env, cwd = process.cwd()): string {
  const configured = env.VEHICLE_OCR_WORKER_PATH?.trim()
  return configured && path.isAbsolute(configured) ? configured : path.join(cwd, DEFAULT_WORKER_RELATIVE_PATH)
}

/** Empaquetage absent : la lecture est refusée explicitement (jamais repliée sur une lecture dans le serveur). */
export class IsolatedReaderUnavailable extends Error {}

export interface IsolatedReaderOptions {
  workerPath: string
  maxPdfImagePixels: number
  /** Tas JavaScript de l'enfant (Mo). */
  maxOldSpaceMb?: number
  /** Mémoire résidente totale de l'enfant (Mo), surveillée par son chien de garde. */
  rssLimitMb?: number
  /** Marge au-delà du délai de lecture avant SIGKILL par le parent, sans signal (ms). */
  hardMarginMs?: number
  /** Après une réponse, délai laissé à l'enfant pour sortir seul avant SIGKILL (ms). */
  exitGraceMs?: number
  /** Tests uniquement (par ex. `--import tsx` pour des enfants factices en TypeScript). Jamais en production. */
  extraExecArgv?: string[]
  /** Tests : pid de chaque enfant lancé. */
  onSpawn?: (pid: number) => void
}

type Reader = (bytes: Uint8Array, kind: DocumentKind, opts: { timeoutMs: number; signal: AbortSignal }) => Promise<Reading>

const failure = (reason: "TIMEOUT" | "OCR_ERROR", durationMs: number): Reading =>
  ({ text: "", status: "TECHNICAL_FAILURE", reason, durationMs, pages: 1, rotation: null, confidence: null, mrzFound: false })

export function createIsolatedReader(options: IsolatedReaderOptions): Reader {
  const maxOldSpaceMb = options.maxOldSpaceMb ?? 256
  const rssLimitMb = options.rssLimitMb ?? 768
  const hardMarginMs = options.hardMarginMs ?? 3_000
  const exitGraceMs = options.exitGraceMs ?? 2_000
  return (bytes, kind, { timeoutMs, signal }) => {
    if (!existsSync(options.workerPath)) return Promise.reject(new IsolatedReaderUnavailable())
    const started = Date.now()
    if (signal.aborted) return Promise.resolve(failure("TIMEOUT", 0))
    return new Promise<Reading>((resolve) => {
      const hardLimitMs = timeoutMs + hardMarginMs
      let reply: Reading | null = null
      let replied = false, aborted = false, failed = false, settled = false
      let hard: ReturnType<typeof setTimeout> | undefined, exitGrace: ReturnType<typeof setTimeout> | undefined
      let child: ChildProcess | undefined
      // Résolution UNIQUE, avec nettoyage complet (minuteries, écouteur d'abandon, écouteurs de l'enfant). Appelée
      // seulement quand aucun processus n'existe (démarrage raté) ou quand le processus est réellement terminé.
      const settle = () => {
        if (settled) return
        settled = true
        if (hard) clearTimeout(hard)
        if (exitGrace) clearTimeout(exitGrace)
        signal.removeEventListener("abort", onAbort)
        child?.removeAllListeners("message"); child?.removeAllListeners("exit")
        // Un écouteur `error` vide reste attaché : une erreur tardive (double événement) ne doit pas faire planter le serveur.
        child?.removeAllListeners("error"); child?.on("error", () => {})
        const durationMs = Date.now() - started
        resolve(reply && !aborted && !failed ? reply : aborted ? failure("TIMEOUT", durationMs) : failure("OCR_ERROR", durationMs))
      }
      const alive = () => !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null
      // Arrêt forcé. Si aucun processus n'a jamais existé (pas de pid), il n'y a rien à attendre : résolution immédiate.
      // Sinon on attend TOUJOURS l'événement `exit` : la place n'est jamais rendue avant la fin réelle d'un enfant vivant.
      const stop = () => {
        if (!child || child.pid === undefined) return settle()
        if (alive()) try { child.kill("SIGKILL") } catch { /* échec d'envoi du signal : l'attente de `exit` continue */ }
      }
      const onAbort = () => { aborted = true; stop() }
      try {
        child = fork(options.workerPath, [], {
          execArgv: [...(options.extraExecArgv ?? []), `--max-old-space-size=${maxOldSpaceMb}`],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          // Environnement minimal : aucune variable du serveur (jetons, URL de base, clés) n'est transmise.
          env: { NODE_ENV: process.env.NODE_ENV ?? "production", VEHICLE_OCR_RSS_LIMIT_MB: String(rssLimitMb), VEHICLE_OCR_HARD_LIMIT_MS: String(hardLimitMs) },
        })
      } catch {
        // Lancement refusé de façon synchrone : aucun processus n'existe.
        failed = true
        return settle()
      }
      // Erreur de lancement (ENOENT, EAGAIN, EPERM… : pas de pid, `exit` peut ne jamais venir) → résolution immédiate ;
      // erreur après démarrage (signal ou envoi) → arrêt forcé, puis attente de la vraie fin.
      child.on("error", () => { failed = true; stop() })
      child.once("exit", settle)
      // Aucun pid : aucun processus n'existe ; on n'attend ni `error` ni `exit` (qui peuvent ne jamais venir).
      if (child.pid === undefined) { failed = true; return settle() }
      options.onSpawn?.(child.pid)
      // Le parent tue lui-même à l'échéance absolue, même si personne n'abandonne la lecture.
      hard = setTimeout(() => { aborted = true; stop() }, hardLimitMs)
      signal.addEventListener("abort", onAbort, { once: true })
      child.on("message", (message) => {
        if (replied) return
        replied = true
        reply = parseReadReply(message)
        // Réponse reçue (valide ou non) : l'enfant n'a plus rien à faire ; s'il ne sort pas seul, il est tué.
        exitGrace = setTimeout(stop, exitGraceMs)
        if (!reply) stop()
      })
      const request: ReadRequest = { type: "read", bytes, kind, timeoutMs, maxPdfImagePixels: options.maxPdfImagePixels }
      try {
        child.send(request, (error) => { if (error) { failed = true; stop() } })
      } catch {
        // Envoi impossible (canal fermé, sérialisation) : l'enfant est vivant, il est tué et sa fin réelle attendue.
        failed = true
        stop()
      }
    })
  }
}
