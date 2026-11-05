/**
 * R4 — contrôle préalable de la recette d'intégration locale (voir .support.ts et
 * docs/coordination/VEHICLE-FUEL-TRIP-001/RECETTE-INTEGRATION-LOCALE.md).
 *
 * Usage : node --import tsx scripts/verification/vehicle-recette-preflight.ts <racine-copie> [--forbid <chemin>]…
 * N'exécute rien ; n'affiche que des noms et des statuts. Fichiers lus : les attestations désignées explicitement et
 * les sources .ts/.tsx de <racine>/src (recherche de `next/font/google`) ; jamais un .env.
 * Code retour : 0 DÉCLARÉ_À_PROUVER (meilleur verdict possible hors ligne, ce n'est pas une autorisation),
 * 2 BLOQUÉ, 1 REFUS.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { evaluateRecettePreflight, type EgressAttestation, type SchemaAttestation } from "./vehicle-recette-preflight.support"

const argv = process.argv.slice(2)
const forbiddenRoots: string[] = []
let appRoot = process.cwd()
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--forbid" && argv[i + 1]) forbiddenRoots.push(argv[++i])
  else appRoot = path.resolve(argv[i])
}

function sources(dir: string): string[] {
  let entries: import("node:fs").Dirent[] = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap((e) => {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(abs)
    return /\.(ts|tsx)$/.test(e.name) && !e.name.startsWith(".env") ? [abs] : []
  })
}
const remoteFontImports = sources(path.join(appRoot, "src"))
  .filter((f) => { try { return /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")) } catch { return false } })
  .map((f) => path.relative(appRoot, f).split(path.sep).join("/")).sort()

const report = evaluateRecettePreflight({
  env: process.env,
  appRoot,
  forbiddenRoots,
  remoteFontImports,
  exists: existsSync,
  listDir: (dir) => { try { return readdirSync(dir) } catch { return [] } },
  // Seuls fichiers lus en plus des sources : les attestations désignées explicitement (jamais un .env).
  readAttestation: (file) => {
    if (path.basename(file).startsWith(".env")) return null
    try { return JSON.parse(readFileSync(file, "utf8")) as SchemaAttestation & EgressAttestation } catch { return null }
  },
})
for (const c of report.checks) console.log(`${c.status.padEnd(7)} ${c.id} — ${c.message}`)
console.log(`VERDICT ${report.verdict} (rien n'a été lancé)`)
process.exitCode = report.verdict === "DÉCLARÉ_À_PROUVER" ? 0 : report.verdict === "BLOQUÉ" ? 2 : 1
