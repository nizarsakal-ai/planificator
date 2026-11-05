/**
 * Processus de lecture FACTICE pour les tests d'isolation (lancé avec `--import tsx`, jamais en production).
 * Comportement choisi par OCR_FIXTURE_MODE, transmis par le test via le nom du fichier lanceur (voir ../ocr-isolation).
 * Tout est borné pour ne jamais mettre la machine en danger : boucles limitées dans le temps, allocations plafonnées.
 */
import { startWatchdog } from "@/lib/vehicules/v3/ocr-isolation/watchdog"

const reading = { text: "ATTESTATION D'ASSURANCE\nVéhicule assuré : AB-123-CD", status: "TEXT_LAYER", reason: null, durationMs: 3, pages: 1, rotation: null, confidence: null, mrzFound: false }
const keepAlive = () => setInterval(() => {}, 1_000)
/** Calcul bloquant le fil principal, plafonné à 20 s par sécurité (le test attend un SIGKILL bien avant). */
const spin = () => { const end = Date.now() + 20_000; while (Date.now() < end) { /* calcul bloquant */ } }

export function run(mode: string) {
  // Garde-fous des factices eux-mêmes : jamais d'orphelin si le test (parent) disparaît, durée de vie plafonnée.
  process.on("disconnect", () => process.exit(0))
  setTimeout(() => process.exit(0), 30_000).unref()
  if (mode === "native-hog") {
    // Chien de garde réel, limite basse : la mémoire native (Buffer hors tas JS) dépasse 160 Mo et le processus est tué
    // alors que le fil principal est bloqué dans une boucle synchrone. Plafond de sécurité : 640 Mo.
    startWatchdog({ rssLimitBytes: 160 * 1024 * 1024, hardLimitMs: 30_000, intervalMs: 10 })
  }
  process.once("message", () => {
    switch (mode) {
      case "reply": process.send!({ type: "reading", reading }, () => process.exit(0)); return
      // Renvoie les NOMS des variables d'environnement reçues (jamais leurs valeurs) : contrôle qu'aucun secret ne passe.
      case "env": process.send!({ type: "reading", reading: { ...reading, text: Object.keys(process.env).sort().join(",") } }, () => process.exit(0)); return
      case "reply-linger": process.send!({ type: "reading", reading }); keepAlive(); return
      case "garbage": process.send!({ type: "reading", reading: { ...reading, status: "HACKED", text: 42 } }); keepAlive(); return
      case "crash": process.exit(3); return
      case "silent": keepAlive(); return
      case "spin": spin(); return
      case "ignore-term": process.on("SIGTERM", () => {}); keepAlive(); return
      case "heap-hog": { const keep: unknown[] = []; for (let i = 0; i < 5_000_000; i++) keep.push({ i, pad: "x".repeat(64) + i }); keepAlive(); return }
      case "native-hog": {
        const keep: Buffer[] = []
        const started = Date.now()
        // Buffer.alloc remplit la mémoire (pages réellement touchées) ; boucle synchrone : seul le fil de garde tourne.
        while (keep.length < 40 && Date.now() - started < 20_000) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); const t = Date.now() + 30; while (Date.now() < t) { /* laisse échantillonner */ } }
        keepAlive(); return
      }
    }
  })
}
