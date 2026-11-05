/**
 * VEHICLE-FUEL-TRIP-001 / VEHICLE-DOC-OCR-001 R4 — contrôle préalable « fail-closed » de la recette d'intégration
 * locale (Next + authentification réelle + PostgreSQL local pré-schématisé).
 *
 * Ce contrôle NE lance RIEN : ni Next, ni PostgreSQL, ni migration, ni réseau. Il ne lit aucun fichier .env (il
 * vérifie seulement leur absence, puisque Next les chargerait), n'ouvre aucune connexion et n'affiche aucune valeur :
 * seulement des noms de variables et des statuts. Le schéma de la base ne peut pas être prouvé sans connexion : au
 * mieux il est DÉCLARÉ par une attestation, à confirmer par une lecture seule autorisée séparément.
 *
 * Réseau : Next télécharge les polices `next/font/google` en développement et envoie sa télémétrie par défaut ; les
 * seules variables ne garantissent donc pas « aucun appel externe ». Télémétrie non coupée : REFUS ; blocage sortant
 * effectif : au mieux DÉCLARÉ par une attestation (ce contrôle ne tente aucune connexion pour le prouver).
 *
 * Verdict : REFUS (règle de sécurité violée) > BLOQUÉ (prérequis manquant) > DÉCLARÉ_À_PROUVER (schéma et blocage
 * sortant seulement déclarés : à prouver par un opérateur autorisé, puis accord explicite de Nizar). Il n'existe pas
 * de verdict « prêt » : ce contrôle hors ligne ne peut pas prouver ces deux prérequis. Rien n'est jamais lancé.
 */
import path from "node:path"

export type PreflightStatus = "OK" | "REFUS" | "BLOQUÉ" | "DÉCLARÉ"
export type PreflightCheck = { id: string; status: PreflightStatus; message: string }
export type PreflightVerdict = "REFUS" | "BLOQUÉ" | "DÉCLARÉ_À_PROUVER"
export type PreflightReport = { verdict: PreflightVerdict; checks: PreflightCheck[]; launched: false }

export type SchemaAttestation = { database?: unknown; port?: unknown; migrations?: unknown; isolated?: unknown }
/** Attestation d'un dispositif de blocage sortant (pare-feu, bac à sable réseau…) limité au bouclage. */
export type EgressAttestation = { mechanism?: unknown; scope?: unknown; verifiedAt?: unknown }
export type PreflightInput = {
  env: Record<string, string | undefined>
  /** Racine de l'application à lancer (copie reconstruite, jamais le checkout principal). */
  appRoot: string
  exists: (absolutePath: string) => boolean
  listDir: (absolutePath: string) => string[]
  /** Lecture d'une attestation désignée explicitement (RECETTE_SCHEMA_ATTESTATION, RECETTE_EGRESS_ATTESTATION) ; null si illisible. */
  readAttestation: (absolutePath: string) => (SchemaAttestation & EgressAttestation) | null
  /** Fichiers source (relatifs à la racine) qui importent `next/font/google` : téléchargement au démarrage de Next. */
  remoteFontImports: string[]
  /** Chemins interdits comme racine (checkout principal, autres worktrees). */
  forbiddenRoots?: string[]
}

/** Ports réservés : serveur 3110 d'une autre session, instance PostgreSQL par défaut 5432. */
export const RESERVED_APP_PORTS = new Set(["3110"])
export const RESERVED_DB_PORTS = new Set(["5432"])
/** Adresses de bouclage littérales seulement : « localhost » dépend de la résolution de noms, donc refusé. */
const LOOPBACK = new Set(["127.0.0.1", "[::1]"])
const TEST_MARKER = /(^|[_\-.])(test|tests|testing|recette|disposable|ephemeral)([_\-.]|$)/i
const PROD_MARKER = /production|(^|[_\-.])prod([_\-.]|$)/i
/** Seules variables secrètes admises : le secret de session local jetable et le mot de passe de l'URL de recette. */
const ALLOWED_SECRET_NAMES = new Set(["AUTH_SECRET", "NEXTAUTH_SECRET", "RECETTE_DATABASE_URL", "DATABASE_URL"])
const SECRET_NAME = /(_API_KEY|API_KEY|_TOKEN|_SECRET|SECRET_KEY|PASSWORD|_PASS|PRIVATE_KEY|CREDENTIALS?)$/i
/** Fournisseurs externes (réseau, payant ou non) : leur seule présence suffit à refuser. */
const EXTERNAL_PREFIXES = ["CLOUDINARY", "ANTHROPIC", "RESEND", "GOOGLE", "GMAIL", "OPENAI", "SENTRY", "NEON", "SUPABASE", "UPSTASH", "STRIPE"]
const EXTERNAL_FLAGS = ["PLANIFICATOR_ROUTING_ENABLED", "PLANIFICATOR_VEHICLE_GEOCODING_ENABLED", "PLANIFICATOR_VEHICLE_OCR_ENABLED",
  "PLANIFICATOR_VEHICLE_OCR_BUDGET_ACK", "PLANIFICATOR_ROUTING_GRAPHHOPPER_URL", "PLANIFICATOR_ROUTING_OSRM_URL", "PLANIFICATOR_GEOCODING_IGN_URL"]
/** Variables qui feraient parler Prisma/libpq à une autre base que celle contrôlée. */
const OTHER_DB_VARS = ["DIRECT_URL", "DATABASE_URL_UNPOOLED", "SHADOW_DATABASE_URL", "PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPORT", "PGDATABASE"]

const set = (env: PreflightInput["env"], name: string) => (env[name] ?? "").trim() !== ""

function loopbackUrl(raw: string, schemes: string[]): { ok: true; url: URL } | { ok: false; why: string } {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, why: "illisible" } }
  if (!schemes.includes(url.protocol)) return { ok: false, why: `schéma ${url.protocol} refusé` }
  if (!LOOPBACK.has(url.hostname.toLowerCase())) return { ok: false, why: "hôte non local (seul le bouclage est admis)" }
  if (!url.port) return { ok: false, why: "port explicite requis" }
  return { ok: true, url }
}

export function evaluateRecettePreflight(input: PreflightInput): PreflightReport {
  const { env, appRoot } = input
  const checks: PreflightCheck[] = []
  const add = (id: string, status: PreflightStatus, message: string) => checks.push({ id, status, message })

  // 1. Racine : jamais le checkout principal ni un autre worktree ; aucun fichier .env que Next chargerait.
  const root = path.resolve(appRoot)
  if ((input.forbiddenRoots ?? []).some((f) => path.resolve(f) === root)) add("racine", "REFUS", "racine interdite (checkout principal ou autre worktree)")
  else if (input.exists(path.join(root, ".git"))) add("racine", "REFUS", "racine sous git (checkout ou worktree) : lancer depuis une copie reconstruite (git archive + correctifs)")
  else add("racine", "OK", "copie reconstruite, distincte des emplacements interdits")
  const envFiles = input.listDir(root).filter((f) => /^\.env(\..*)?$/.test(f))
  add("fichiers-env", envFiles.length ? "REFUS" : "OK",
    envFiles.length ? `fichiers présents (non lus) que Next chargerait : ${envFiles.join(", ")} — utiliser une copie reconstruite sans .env` : "aucun fichier .env à la racine")

  // 2. Jamais la production ni un environnement hébergé.
  const hosted = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "NOW_REGION"].filter((n) => set(env, n))
  add("production", env.NODE_ENV === "production" || hosted.length ? "REFUS" : "OK",
    env.NODE_ENV === "production" ? "NODE_ENV=production refusé" : hosted.length ? `environnement hébergé détecté : ${hosted.join(", ")}` : "ni production ni environnement hébergé")

  // 3. Base : URL de recette locale dédiée, identique à DATABASE_URL, aucune autre base atteignable.
  const dbRaw = env.RECETTE_DATABASE_URL?.trim()
  if (!dbRaw) add("base-url", "BLOQUÉ", "RECETTE_DATABASE_URL absente : aucune base locale désignée")
  else {
    const parsed = loopbackUrl(dbRaw, ["postgresql:", "postgres:"])
    if (!parsed.ok) add("base-url", "REFUS", `RECETTE_DATABASE_URL : ${parsed.why}`)
    else {
      const { url } = parsed
      const db = decodeURIComponent(url.pathname.replace(/^\//, ""))
      const user = decodeURIComponent(url.username)
      const problems = [
        url.search || url.hash ? "paramètres de requête interdits (host=, sslmode… pourraient rediriger)" : "",
        RESERVED_DB_PORTS.has(url.port) ? `port ${url.port} réservé (instance par défaut) : instance dédiée requise` : "",
        !db || ["postgres", "template0", "template1"].includes(db.toLowerCase()) ? "nom de base absent ou système" : "",
        db && !TEST_MARKER.test(db) ? "nom de base sans marqueur de recette/test" : "",
        PROD_MARKER.test(db) || PROD_MARKER.test(user) ? "marqueur de production" : "",
        !user || user.toLowerCase() === "postgres" ? "utilisateur absent ou superutilisateur « postgres »" : "",
      ].filter(Boolean)
      add("base-url", problems.length ? "REFUS" : "OK", problems.length ? `RECETTE_DATABASE_URL : ${problems.join(" ; ")}` : "base locale dédiée (bouclage, port dédié, marqueur de recette)")
    }
    add("base-unique", env.DATABASE_URL?.trim() === dbRaw ? "OK" : "REFUS",
      env.DATABASE_URL?.trim() === dbRaw ? "DATABASE_URL = RECETTE_DATABASE_URL" : "DATABASE_URL absente ou différente de RECETTE_DATABASE_URL")
  }
  const otherDb = OTHER_DB_VARS.filter((n) => set(env, n))
  add("autres-bases", otherDb.length ? "REFUS" : "OK", otherDb.length ? `variables de base supplémentaires : ${otherDb.join(", ")}` : "aucune autre base atteignable par variable")

  // 4. Authentification réelle (aucun contournement) : URL de bouclage et secret de session local jetable.
  const authRaw = (env.AUTH_URL ?? env.NEXTAUTH_URL)?.trim()
  if (!authRaw) add("auth-url", "BLOQUÉ", "AUTH_URL absente : adresse locale de l'application non déclarée")
  else {
    const parsed = loopbackUrl(authRaw, ["http:"])
    if (!parsed.ok) add("auth-url", "REFUS", `AUTH_URL : ${parsed.why}`)
    else if (RESERVED_APP_PORTS.has(parsed.url.port)) add("auth-url", "REFUS", `port ${parsed.url.port} réservé (serveur d'une autre session)`)
    else add("auth-url", "OK", `application en bouclage sur le port ${parsed.url.port}`)
  }
  add("auth-secret", set(env, "AUTH_SECRET") || set(env, "NEXTAUTH_SECRET") ? "OK" : "BLOQUÉ",
    set(env, "AUTH_SECRET") || set(env, "NEXTAUTH_SECRET") ? "secret de session présent (valeur non lue ici)" : "AUTH_SECRET absent : valeur locale jetable à fournir sur décision de Nizar")
  const bypass = Object.keys(env).filter((n) => /BYPASS|SKIP_AUTH|AUTH_DISABLED|DEV_LOGIN|IMPERSONAT/i.test(n) && set(env, n))
  add("auth-contournement", bypass.length ? "REFUS" : "OK", bypass.length ? `variables de contournement : ${bypass.join(", ")}` : "aucun contournement d'authentification")

  // 5. Aucun appel externe ou payant : fournisseurs absents, drapeaux réseau éteints, aucune autre clé.
  const external = Object.keys(env).filter((n) => set(env, n) && (EXTERNAL_PREFIXES.some((p) => n.startsWith(p)) || EXTERNAL_FLAGS.includes(n)))
  add("fournisseurs-externes", external.length ? "REFUS" : "OK", external.length ? `fournisseurs ou drapeaux réseau présents : ${external.join(", ")}` : "aucun fournisseur externe configuré")
  const secrets = Object.keys(env).filter((n) => set(env, n) && SECRET_NAME.test(n) && !ALLOWED_SECRET_NAMES.has(n))
  add("cles", secrets.length ? "REFUS" : "OK", secrets.length ? `clés ou secrets non admis : ${secrets.join(", ")}` : "aucune autre clé")
  const fuel = env.PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED?.trim() === "true"
  add("estimation-carburant", fuel ? "REFUS" : "OK", fuel
    ? "PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED=true appellerait IGN et data.economie.gouv.fr : interdit sans environnement réseau isolé autorisé"
    : "estimation carburant éteinte (aucun appel IGN ni prix)")

  // 5 bis. Réseau propre à Next : télémétrie coupée obligatoire ; polices distantes et tout autre appel imprévu
  // exigent un blocage sortant effectif, qui ne peut être que déclaré ici.
  add("telemetrie-next", env.NEXT_TELEMETRY_DISABLED?.trim() === "1" ? "OK" : "REFUS",
    env.NEXT_TELEMETRY_DISABLED?.trim() === "1" ? "télémétrie Next coupée" : "NEXT_TELEMETRY_DISABLED=1 requis (télémétrie Next active par défaut : appel sortant)")
  const fonts = input.remoteFontImports
  const egressPath = env.RECETTE_EGRESS_ATTESTATION?.trim()
  const needs = fonts.length ? `polices next/font/google téléchargées au démarrage (${fonts.join(", ")})` : "aucune police distante détectée, appels imprévus possibles"
  if (!egressPath) add("reseau-sortant", "BLOQUÉ", `blocage sortant effectif NON PROUVÉ (${needs}) : aucune attestation RECETTE_EGRESS_ATTESTATION`)
  else if (!path.isAbsolute(egressPath) || !input.exists(egressPath)) add("reseau-sortant", "BLOQUÉ", "attestation de blocage sortant introuvable (chemin absolu requis)")
  else {
    const e = input.readAttestation(egressPath)
    const ok = !!e && typeof e.mechanism === "string" && e.mechanism.trim() !== "" && e.scope === "loopback-only" && typeof e.verifiedAt === "string"
    add("reseau-sortant", ok ? "DÉCLARÉ" : "BLOQUÉ", ok
      ? `blocage sortant DÉCLARÉ (${needs}) — à prouver par l'opérateur autorisé avant lancement, non prouvé par ce contrôle`
      : "attestation de blocage sortant refusée : mechanism, scope « loopback-only » et verifiedAt requis")
  }

  // 6. Schéma : non prouvable sans connexion. Attestation déclarée comparée aux migrations du dépôt, sinon BLOQUÉ.
  const attestationPath = env.RECETTE_SCHEMA_ATTESTATION?.trim()
  const migrationsDir = path.join(root, "prisma/migrations")
  const migrations = input.exists(migrationsDir) ? input.listDir(migrationsDir).filter((d) => /^\d{8,}_/.test(d)).sort() : []
  if (!attestationPath) add("schema", "BLOQUÉ", "base pré-schématisée isolée NON PROUVÉE : aucune attestation (RECETTE_SCHEMA_ATTESTATION) — ne créer aucun schéma ici")
  else if (!path.isAbsolute(attestationPath) || !input.exists(attestationPath)) add("schema", "BLOQUÉ", "attestation introuvable (chemin absolu requis)")
  else {
    const a = input.readAttestation(attestationPath)
    const dbName = dbRaw ? (() => { try { return decodeURIComponent(new URL(dbRaw).pathname.slice(1)) } catch { return "" } })() : ""
    const dbPort = dbRaw ? (() => { try { return new URL(dbRaw).port } catch { return "" } })() : ""
    const declared = Array.isArray(a?.migrations) && a.migrations.every((m) => typeof m === "string") ? [...(a.migrations as string[])].sort() : null
    const problems = !a ? ["illisible"] : [
      a.isolated !== true ? "isolement non déclaré" : "",
      a.database !== dbName ? "base différente de RECETTE_DATABASE_URL" : "",
      String(a.port) !== dbPort ? "port différent" : "",
      !declared ? "liste de migrations absente" : JSON.stringify(declared) !== JSON.stringify(migrations) ? "migrations déclarées ≠ migrations du dépôt" : "",
      !migrations.length ? "aucune migration dans la copie" : "",
    ].filter(Boolean)
    add("schema", problems.length ? "BLOQUÉ" : "DÉCLARÉ", problems.length ? `attestation refusée : ${problems.join(" ; ")}`
      : `schéma DÉCLARÉ (${migrations.length} migrations) — à confirmer par une lecture seule autorisée, non prouvé par ce contrôle`)
  }

  // 7. Processus OCR empaqueté (sinon la lecture répond 503) : produit par npm run build/dev.
  const worker = input.exists(path.join(root, ".vehicle-ocr-worker/worker.cjs")) && input.exists(path.join(root, ".vehicle-ocr-worker/trace.json"))
  add("processus-ocr", worker ? "OK" : "BLOQUÉ", worker ? "processus de lecture empaqueté" : "processus de lecture absent : npm run build:vehicle-ocr-worker dans la copie")

  const verdict: PreflightVerdict = checks.some((c) => c.status === "REFUS") ? "REFUS" : checks.some((c) => c.status === "BLOQUÉ") ? "BLOQUÉ" : "DÉCLARÉ_À_PROUVER"
  return { verdict, checks, launched: false }
}
