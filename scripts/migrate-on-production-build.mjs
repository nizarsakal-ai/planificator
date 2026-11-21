// ═══════════════════════════════════════════════════════════════════════════
// Migrations SQL appliquées par le build Vercel de PRODUCTION (21/11/2026).
// Jusqu'ici, Vercel n'exécutait aucune migration (`prisma migrate deploy` manuel) : un déploiement dont le code lit une
// colonne pas encore créée cassait la production. Désormais, le build de production applique les migrations en attente
// AVANT de compiler. Règles :
//   - production uniquement (VERCEL_ENV=production) ; previews et builds locaux : rien n'est appliqué ;
//   - échec de la migration ⇒ échec du build ⇒ Vercel garde le déploiement précédent en ligne (jamais de code sans schéma) ;
//   - connexion DIRECTE à Neon : `DIRECT_URL` si défini, sinon `DATABASE_URL` sans le suffixe « -pooler » de l'hôte
//     (Prisma Migrate exige une session, pas le pooler en mode transaction) ;
//   - l'URL n'est jamais affichée (hôte et base seulement) ; `SKIP_BUILD_MIGRATIONS=1` désactive l'étape (secours).
// ═══════════════════════════════════════════════════════════════════════════
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

/** Décide si le build doit appliquer les migrations. */
export function shouldMigrate(env) {
  if (env.SKIP_BUILD_MIGRATIONS === "1") return { run: false, reason: "SKIP_BUILD_MIGRATIONS=1" }
  if (env.VERCEL_ENV !== "production") return { run: false, reason: `environnement « ${env.VERCEL_ENV ?? "local"} » (production uniquement)` }
  return { run: true, reason: "build de production" }
}

/** URL de connexion directe pour Prisma Migrate ; lève une erreur explicite si aucune URL exploitable. */
export function migrationUrl(env) {
  const raw = (env.DIRECT_URL || env.DATABASE_URL || "").trim()
  if (!raw) throw new Error("Aucune URL de base (DIRECT_URL ou DATABASE_URL) dans l'environnement de build.")
  let u
  try { u = new URL(raw) } catch { throw new Error("URL de base illisible (format attendu : postgresql://…).") }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new Error("URL de base : protocole postgresql:// attendu.")
  if (!env.DIRECT_URL) u.hostname = u.hostname.replace("-pooler.", ".")
  u.searchParams.delete("pgbouncer")
  return u.toString()
}

/** Description sans secret de la cible (journal du build). */
export function describeTarget(url) {
  const u = new URL(url)
  return `${u.hostname}${u.pathname}`
}

function main() {
  const decision = shouldMigrate(process.env)
  if (!decision.run) { console.log(`[migrations] ignorées : ${decision.reason}`); return 0 }
  let url
  try { url = migrationUrl(process.env) } catch (e) { console.error(`[migrations] ÉCHEC : ${e.message}`); return 1 }
  console.log(`[migrations] prisma migrate deploy sur ${describeTarget(url)}`)
  const r = spawnSync("npx", ["--no-install", "prisma", "migrate", "deploy"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url }, timeout: 300_000 })
  if (r.status !== 0) { console.error(`[migrations] ÉCHEC (code ${r.status ?? r.signal}) : build interrompu, le déploiement en ligne est conservé.`); return 1 }
  console.log("[migrations] terminées.")
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main())
