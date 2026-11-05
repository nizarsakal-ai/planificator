/**
 * R4 point 2 — préparation de la recette d'intégration locale : contrôle préalable fail-closed et jeu de données
 * synthétique. Rien n'est lancé : ni Next, ni PostgreSQL, ni réseau ; aucune lecture de .env (existence seulement).
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { addDays, parisDayStart, resolveStays, type StayAssignment, type StayTruckPeriod } from "@/lib/vehicules/v3/fuel-estimate-domain"
import { evaluateRecettePreflight, type PreflightInput } from "../../../scripts/verification/vehicle-recette-preflight.support"
import {
  RECETTE_EMAIL_DOMAIN, RECETTE_MARKER, RECETTE_SCAN_DAYS, recetteCompanies, recetteStays, recetteTrucks, recetteUsers, recetteWorksites,
} from "../../../scripts/verification/vehicle-recette.fixtures"

const ROOT = process.cwd()
const SUPPORT = path.join(ROOT, "scripts/verification/vehicle-recette-preflight.support.ts")

describe("R4 — jeu de données synthétique", () => {
  it("marqueurs : sociétés, camions, chantiers RECETTE ; adresses en .invalid ; aucun mot de passe", () => {
    for (const c of recetteCompanies) assert.match(c.name, new RegExp(RECETTE_MARKER))
    for (const t of recetteTrucks) { assert.match(t.label, new RegExp(RECETTE_MARKER)); assert.match(t.plate, /^RC-\d{3}-[A-Z]{2}$/) }
    for (const w of recetteWorksites) assert.match(w.name, new RegExp(RECETTE_MARKER))
    for (const u of recetteUsers) { assert.ok(u.email.endsWith(`@${RECETTE_EMAIL_DOMAIN}`)); assert.equal("password" in u, false) }
    assert.ok(new Set(recetteUsers.map((u) => u.company)).size >= 2, "deux sociétés pour les refus inter-sociétés")
    assert.ok(recetteUsers.some((u) => !u.active), "compte inactif pour le refus de connexion")
    assert.ok(recetteWorksites.some((w) => w.latitude === null), "chantier sans coordonnées")
  })

  it("séjours : la règle de production donne exactement les blocages annoncés (lundi de référence)", () => {
    const today = "2026-11-09" // lundi
    assert.equal(new Date(`${today}T12:00:00Z`).getUTCDay(), 1)
    const scan = { from: addDays(today, -RECETTE_SCAN_DAYS), to: addDays(today, RECETTE_SCAN_DAYS) }
    for (const s of recetteStays) {
      const worksite = recetteWorksites.find((w) => w.key === s.worksite)!
      const assignments: StayAssignment[] = []
      for (let d = s.startOffsetDays; d <= s.endOffsetDays; d++) {
        const date = addDays(today, d)
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
        if (s.weekdaysOnly && (weekday === 0 || weekday === 6)) continue
        assignments.push({ date, teamId: "equipe", worksite: { id: worksite.key, name: worksite.name, address: "RECETTE adresse", latitude: worksite.latitude, longitude: worksite.longitude } })
      }
      const long = parisDayStart(addDays(today, -400))
      const periods: StayTruckPeriod[] = s.history === "NONE"
        ? [{ teamId: "equipe", chauffeurId: "chauffeur", startedAt: long, endedAt: null, fallback: true }]
        : s.handoverDayOffset === null ? [{ teamId: "equipe", chauffeurId: "chauffeur", startedAt: long, endedAt: null }]
        : (() => { const at = parisDayStart(addDays(today, s.handoverDayOffset!)) + 10 * 3_600_000
          return [{ teamId: "equipe", chauffeurId: "chauffeur", startedAt: long, endedAt: at }, { teamId: "equipe", chauffeurId: "autre", startedAt: at, endedAt: null }] })()
      const stays = resolveStays(assignments, periods, scan).sort((a, b) => a.departure.localeCompare(b.departure))
      assert.deepEqual(stays.map((x) => ({ blocked: x.blocked, gaps: x.gaps.length })), s.expected, s.key)
    }
  })
})

const base = (over: Partial<PreflightInput["env"]> = {}): PreflightInput => {
  const files: Record<string, string[]> = { "/copie": ["package.json", "prisma", ".vehicle-ocr-worker"], "/copie/prisma/migrations": ["20260101000000_a", "20260102000000_b", "migration_lock.toml"] }
  const present = new Set(["/copie/prisma/migrations", "/attestation.json", "/sortant.json", "/copie/.vehicle-ocr-worker/worker.cjs", "/copie/.vehicle-ocr-worker/trace.json"])
  return {
    appRoot: "/copie",
    env: {
      RECETTE_DATABASE_URL: "postgresql://vehicule_recette:mdp-synthetique-7731@127.0.0.1:55433/vehicules_recette_r4",
      DATABASE_URL: "postgresql://vehicule_recette:mdp-synthetique-7731@127.0.0.1:55433/vehicules_recette_r4",
      AUTH_URL: "http://127.0.0.1:3311", AUTH_SECRET: "secret-jetable-synthetique-9912",
      RECETTE_SCHEMA_ATTESTATION: "/attestation.json", RECETTE_EGRESS_ATTESTATION: "/sortant.json", NEXT_TELEMETRY_DISABLED: "1",
      PLANIFICATOR_VEHICLES_V3_ENABLED: "true", PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED: "true", NODE_ENV: "development", ...over,
    },
    remoteFontImports: ["src/app/layout.tsx", "src/components/auth/LoginExperience.tsx"],
    exists: (p) => present.has(p),
    listDir: (p) => files[p] ?? [],
    readAttestation: (p) => p === "/sortant.json"
      ? { mechanism: "pare-feu applicatif : sortie refusée sauf bouclage (synthétique)", scope: "loopback-only", verifiedAt: "2026-11-04" }
      : { isolated: true, database: "vehicules_recette_r4", port: 55433, migrations: ["20260101000000_a", "20260102000000_b"] },
  }
}
const verdict = (input: PreflightInput) => evaluateRecettePreflight(input)
const status = (input: PreflightInput, id: string) => verdict(input).checks.find((c) => c.id === id)?.status

describe("R4 — contrôle préalable fail-closed de la recette", () => {
  it("tout conforme : au mieux DÉCLARÉ_À_PROUVER (schéma et blocage sortant seulement déclarés), rien de lancé", () => {
    const r = verdict(base())
    assert.equal(r.verdict, "DÉCLARÉ_À_PROUVER"); assert.equal(r.launched, false)
    assert.equal(r.checks.find((c) => c.id === "schema")?.status, "DÉCLARÉ")
    assert.equal(r.checks.find((c) => c.id === "reseau-sortant")?.status, "DÉCLARÉ")
    assert.equal(r.checks.some((c) => c.status === "BLOQUÉ" || c.status === "REFUS"), false)
  })
  it("réseau propre à Next : télémétrie non coupée = REFUS ; sans blocage sortant attesté = BLOQUÉ (polices Google citées)", () => {
    assert.equal(status(base({ NEXT_TELEMETRY_DISABLED: undefined }), "telemetrie-next"), "REFUS")
    assert.equal(status(base({ NEXT_TELEMETRY_DISABLED: "0" }), "telemetrie-next"), "REFUS")
    const none = verdict(base({ RECETTE_EGRESS_ATTESTATION: undefined }))
    assert.equal(none.verdict, "BLOQUÉ")
    assert.match(none.checks.find((c) => c.id === "reseau-sortant")!.message, /NON PROUVÉ.*next\/font\/google.*src\/app\/layout\.tsx/)
    const wide = { ...base(), readAttestation: (p: string) => p === "/sortant.json" ? { mechanism: "x", scope: "all", verifiedAt: "2026-11-04" } : base().readAttestation(p) }
    assert.equal(status(wide, "reseau-sortant"), "BLOQUÉ")
    assert.equal(status(base({ RECETTE_EGRESS_ATTESTATION: "sortant.json" }), "reseau-sortant"), "BLOQUÉ", "chemin relatif")
  })
  it("aucune valeur affichée : ni mot de passe, ni secret, ni clé", () => {
    const text = JSON.stringify(verdict(base({ ANTHROPIC_API_KEY: "sk-synthetique-5521", CLOUDINARY_URL: "cloudinary://synthetique-8812" })))
    for (const v of ["mdp-synthetique-7731", "secret-jetable-synthetique-9912", "sk-synthetique-5521", "synthetique-8812", "vehicule_recette:"]) assert.equal(text.includes(v), false, v)
  })
  it("réseau : hôtes non bouclage refusés (base et application)", () => {
    for (const host of ["10.0.0.5", "0.0.0.0", "db.example.test", "postgres", "ep-x.neon.tech", "[::ffff:10.0.0.1]", "localhost"])
      assert.equal(status(base({ RECETTE_DATABASE_URL: `postgresql://vehicule_recette:x@${host}:55433/vehicules_recette_r4` }), "base-url"), "REFUS", host)
    assert.equal(status(base({ AUTH_URL: "http://192.168.1.4:3311" }), "auth-url"), "REFUS")
    assert.equal(status(base({ AUTH_URL: "https://planificator.example.test" }), "auth-url"), "REFUS")
    assert.equal(status(base({ AUTH_URL: "http://127.0.0.1:3110" }), "auth-url"), "REFUS", "serveur d'une autre session")
  })
  it("base : port par défaut, base système, sans marqueur, production, superutilisateur, paramètres, DATABASE_URL différente", () => {
    const url = (u: string) => base({ RECETTE_DATABASE_URL: u, DATABASE_URL: u })
    for (const u of ["postgresql://vehicule_recette:x@127.0.0.1:5432/vehicules_recette_r4", "postgresql://vehicule_recette:x@127.0.0.1:55433/postgres",
      "postgresql://vehicule_recette:x@127.0.0.1:55433/planificator", "postgresql://vehicule_recette:x@127.0.0.1:55433/recette_prod",
      "postgresql://postgres:x@127.0.0.1:55433/vehicules_recette_r4", "postgresql://vehicule_recette:x@127.0.0.1:55433/vehicules_recette_r4?host=10.0.0.5",
      "postgresql://vehicule_recette:x@127.0.0.1/vehicules_recette_r4", "mysql://vehicule_recette:x@127.0.0.1:55433/vehicules_recette_r4"])
      assert.equal(verdict(url(u)).verdict, "REFUS", u)
    assert.equal(status(base({ DATABASE_URL: "postgresql://autre:x@127.0.0.1:55433/vehicules_recette_r4" }), "base-unique"), "REFUS")
    assert.equal(status(base({ DIRECT_URL: "postgresql://x" }), "autres-bases"), "REFUS")
    assert.equal(status(base({ PGHOST: "10.0.0.5" }), "autres-bases"), "REFUS")
  })
  it("production et hébergement refusés", () => {
    assert.equal(verdict(base({ NODE_ENV: "production" })).verdict, "REFUS")
    assert.equal(verdict(base({ VERCEL_ENV: "preview" })).verdict, "REFUS")
  })
  it("appels externes ou payants refusés : fournisseurs, drapeaux réseau, estimation carburant, autres clés", () => {
    for (const env of [{ CLOUDINARY_URL: "x" }, { ANTHROPIC_API_KEY: "x" }, { RESEND_API_KEY: "x" }, { GOOGLE_CLIENT_ID: "x" },
      { PLANIFICATOR_ROUTING_ENABLED: "true" }, { PLANIFICATOR_VEHICLE_GEOCODING_ENABLED: "true" }, { PLANIFICATOR_VEHICLE_OCR_ENABLED: "true" },
      { PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED: "true" }, { PLANIFICATOR_ROUTING_TOKEN: "x" }, { MON_SERVICE_API_KEY: "x" }])
      assert.equal(verdict(base(env)).verdict, "REFUS", Object.keys(env)[0])
  })
  it("authentification : aucun contournement ; secret ou adresse absents = BLOQUÉ", () => {
    assert.equal(verdict(base({ AUTH_BYPASS: "1" })).verdict, "REFUS")
    assert.equal(verdict(base({ SKIP_AUTH: "true" })).verdict, "REFUS")
    assert.equal(verdict(base({ AUTH_SECRET: undefined })).verdict, "BLOQUÉ")
    assert.equal(verdict(base({ AUTH_URL: undefined })).verdict, "BLOQUÉ")
  })
  it("schéma non prouvé : sans attestation, attestation incohérente ou non isolée = BLOQUÉ (aucune création de schéma)", () => {
    assert.equal(status(base({ RECETTE_SCHEMA_ATTESTATION: undefined }), "schema"), "BLOQUÉ")
    assert.equal(status(base({ RECETTE_SCHEMA_ATTESTATION: "attestation.json" }), "schema"), "BLOQUÉ", "chemin relatif")
    const att = (a: object) => ({ ...base(), readAttestation: () => a })
    assert.equal(status(att({ isolated: true, database: "vehicules_recette_r4", port: 55433, migrations: ["20260101000000_a"] }), "schema"), "BLOQUÉ", "migration manquante")
    assert.equal(status(att({ isolated: false, database: "vehicules_recette_r4", port: 55433, migrations: ["20260101000000_a", "20260102000000_b"] }), "schema"), "BLOQUÉ")
    assert.equal(status(att({ isolated: true, database: "autre_recette", port: 55433, migrations: ["20260101000000_a", "20260102000000_b"] }), "schema"), "BLOQUÉ")
    assert.equal(status({ ...base(), readAttestation: () => null }, "schema"), "BLOQUÉ")
  })
  it("racine : fichiers .env présents (non lus), checkout git ou racine interdite = REFUS", () => {
    const withEnv = base(); const list = withEnv.listDir
    assert.equal(verdict({ ...withEnv, listDir: (p) => p === "/copie" ? [...list(p), ".env.local"] : list(p) }).verdict, "REFUS")
    const exists = base().exists
    assert.equal(verdict({ ...base(), exists: (p) => p === "/copie/.git" || exists(p) }).verdict, "REFUS")
    assert.equal(verdict({ ...base(), forbiddenRoots: ["/copie"] }).verdict, "REFUS")
  })
  it("système de fichiers réel (dossier temporaire synthétique) : copie sans git = racine OK ; avec .git = REFUS", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "vocr-racine-"))
    try {
      const real = (): PreflightInput => ({ ...base(), appRoot: dir, exists: existsSync, listDir: (d) => { try { return readdirSync(d) } catch { return [] } } })
      assert.equal(evaluateRecettePreflight(real()).checks.find((c) => c.id === "racine")?.status, "OK")
      assert.equal(evaluateRecettePreflight(real()).checks.find((c) => c.id === "fichiers-env")?.status, "OK")
      mkdirSync(path.join(dir, ".git"))
      const r = evaluateRecettePreflight(real())
      assert.equal(r.checks.find((c) => c.id === "racine")?.status, "REFUS"); assert.equal(r.verdict, "REFUS")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it("le contrôle n'importe ni base, ni réseau, ni processus, et ne lit aucun .env", () => {
    const src = readFileSync(SUPPORT, "utf8")
    for (const forbidden of [/from "@prisma/, /from "pg"/, /node:net|node:http|node:https|node:child_process/, /\bfetch\(/, /readFileSync/, /dotenv/])
      assert.equal(forbidden.test(src), false, String(forbidden))
  })
})
