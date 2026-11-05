/**
 * Véhicules V3 — chien de garde du processus de lecture isolé (côté enfant).
 *
 * Tourne dans un fil `worker_threads` distinct : il continue d'échantillonner même quand le fil principal est bloqué
 * dans du code natif (décodage sharp/libvips, WASM Tesseract, boucle pdf.js). Il tue le processus ENTIER (SIGKILL sur
 * son propre pid) dès que la mémoire résidente dépasse la limite, dès l'échéance absolue, ou si le parent disparaît.
 * Limite connue : l'échantillonnage (25 ms par défaut) laisse passer un pic d'allocation entre deux mesures ; la
 * mémoire résidente n'est pas une réservation (le système peut déjà avoir accordé davantage au moment du SIGKILL).
 */
import { Worker } from "node:worker_threads"

export interface WatchdogOptions {
  /** Mémoire résidente maximale du processus entier (octets). */
  rssLimitBytes: number
  /** Échéance absolue depuis le démarrage (ms) : au-delà, SIGKILL quel que soit l'état. */
  hardLimitMs: number
  intervalMs?: number
}

// Code du fil de garde : volontairement autonome (aucun import applicatif), évalué tel quel.
const SOURCE = `
const { workerData } = require("node:worker_threads")
const started = Date.now()
const kill = () => { try { process.kill(process.pid, "SIGKILL") } catch { process.exit(137) } }
setInterval(() => {
  if (Date.now() - started > workerData.hardLimitMs) kill()
  if (process.memoryUsage.rss() > workerData.rssLimitBytes) kill()
  // Parent disparu (ppid réattribué) : le travail n'a plus de destinataire.
  if (process.ppid !== workerData.ppid) kill()
}, workerData.intervalMs)
`

export function startWatchdog(options: WatchdogOptions): Worker {
  const watchdog = new Worker(SOURCE, {
    eval: true,
    workerData: { rssLimitBytes: options.rssLimitBytes, hardLimitMs: options.hardLimitMs, intervalMs: options.intervalMs ?? 25, ppid: process.ppid },
  })
  // Le chien de garde ne doit jamais retenir la fin normale du processus.
  watchdog.unref()
  return watchdog
}
