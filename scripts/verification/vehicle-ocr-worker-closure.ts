/**
 * VEHICLE-DOC-OCR-001 R4 — `npm run verify:vehicle-ocr-worker [-- --keep] [-- --no-rebuild]`
 * Vérifie localement la fermeture des dépendances du processus de lecture OCR (voir .support.ts). Code retour 0
 * seulement si tous les contrôles passent. Aucune preuve serverless/Vercel.
 */
import { verifyVehicleOcrWorkerClosure } from "./vehicle-ocr-worker-closure.support"

const argv = process.argv.slice(2)
const args = new Set(argv)
const tmp = argv.indexOf("--tmp")
const tmpBase = tmp >= 0 ? argv[tmp + 1] : undefined
verifyVehicleOcrWorkerClosure({ keep: args.has("--keep"), rebuild: !args.has("--no-rebuild"), tmpBase }).then((report) => {
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
}, (error) => {
  console.error(`Vérification de fermeture impossible : ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
