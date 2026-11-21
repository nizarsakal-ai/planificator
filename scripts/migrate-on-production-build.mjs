// ═══════════════════════════════════════════════════════════════════════════
// Garde de schéma du build Vercel de PRODUCTION (21/11/2026) — LECTURE SEULE.
// Vercel n'applique aucune migration : conformément à docs/runbooks/DB-APP-ROLE.md, l'application se connecte avec un rôle
// sans DDL (`planificator_app`) et les migrations sont appliquées par `neondb_owner`, dont l'URL n'est jamais dans Vercel.
// Ce script vérifie seulement, avant de compiler, que la base de production a toutes les migrations du code
// (`prisma migrate status`). Migration en attente ou en échec ⇒ build interrompu ⇒ Vercel garde le déploiement précédent :
// jamais de code en ligne qui lirait une colonne pas encore créée. Aucune écriture en base (pas de ligne d'échec ajoutée).
//   - production uniquement (VERCEL_ENV=production) ; previews et builds locaux : rien n'est vérifié ;
//   - connexion directe Neon : `DIRECT_URL` si défini, sinon `DATABASE_URL` sans le suffixe « -pooler » de l'hôte ;
//   - l'URL n'est jamais affichée (hôte et base seulement) ; `SKIP_BUILD_MIGRATIONS=1` désactive la garde (secours).
// ═══════════════════════════════════════════════════════════════════════════
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"

/** Décide si le build doit vérifier le schéma. */
export function shouldMigrate(env) {
  if (env.SKIP_BUILD_MIGRATIONS === "1") return { run: false, reason: "SKIP_BUILD_MIGRATIONS=1" }
  if (env.VERCEL_ENV !== "production") return { run: false, reason: `environnement « ${env.VERCEL_ENV ?? "local"} » (production uniquement)` }
  return { run: true, reason: "build de production" }
}

/** URL de connexion directe ; lève une erreur explicite si aucune URL exploitable. */
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
  if (!decision.run) { console.log(`[schéma] vérification ignorée : ${decision.reason}`); return 0 }
  let url
  try { url = migrationUrl(process.env) } catch (e) { console.error(`[schéma] ÉCHEC : ${e.message}`); return 1 }
  console.log(`[schéma] prisma migrate status sur ${describeTarget(url)} (lecture seule)`)
  const r = spawnSync("npx", ["--no-install", "prisma", "migrate", "status"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url }, timeout: 120_000 })
  if (r.status !== 0) {
    console.error("[schéma] BASE EN RETARD sur le code (migration en attente ou en échec) : build interrompu, le déploiement en ligne est conservé.")
    console.error("[schéma] Appliquer la migration avec le rôle propriétaire (docs/runbooks/DB-APP-ROLE.md, étape 5), puis relancer le déploiement.")
    return 1
  }
  console.log("[schéma] base à jour.")
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main())
