/**
 * LOT-1W-1a — Enregistrement des références de parité sur BASE_SHA (fiche rév. 3, §3.2 et §9.1).
 *
 * Exécuté UNE fois par fuseau, dans le worktree de référence, sur les actions ORIGINALES :
 *
 *   TZ=UTC          node --import tsx --experimental-test-module-mocks tests/chantiers/parity/record-reference.ts
 *   TZ=Europe/Paris node --import tsx --experimental-test-module-mocks tests/chantiers/parity/record-reference.ts
 *
 * Quatre gardes (fiche §9.1), toutes bloquantes ; toutes sont évaluées et rapportées avant refus :
 *   (a) `git rev-parse HEAD` = BASE_SHA ;
 *   (b) aucune modification SUIVIE hors `tests/chantiers/parity/**` et `package.json` (ligne
 *       `test:chantiers` uniquement, vérifiée par diff restreint) ;
 *   (c) aucun fichier NON SUIVI sous `src/**`, `prisma/**`, `next.config.ts` ;
 *   (d) empreinte SHA-256 de chaque fichier du graphe d'import des deux actions égale à celle de
 *       `git show BASE_SHA:<chemin>`.
 *
 * Un échec de chargement de `chantier.actions.ts` n'est jamais une référence valide (sortie 1).
 * Les snapshots existants ne sont jamais écrasés (sortie 1) : ils ne sont pas régénérés.
 * Chaque cas est exécuté deux fois ; une trace non reproductible est un défaut du harnais (sortie 1).
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  BASE_SHA,
  CASES,
  DOUBLED_MODULES,
  FROZEN_CLOCK_ISO,
  RECORD_COMMAND,
  REFERENCE_DIR,
  SUPPORTED_TZ,
  loadActions,
  referenceFileName,
  runCase,
  stableJson,
  type ActionsModule,
  type CaseRecord,
} from "./harness"

// Horloge réelle relevée AVANT le gel (loadActions fige Date).
const REAL_STARTED_AT = new Date().toISOString()

// ---- Outils git ---------------------------------------------------------------------------------

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function gitBytes(root: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

// ---- Graphe d'import des deux actions à BASE_SHA (fiche §9.1-d) --------------------------------

const STATIC_IMPORT_GRAPH = [
  "src/lib/actions/chantier.actions.ts",
  "src/lib/validations/chantier.ts",
  "src/lib/actions/chantier-block.core.ts",
  "src/auth.ts",
  "src/auth.config.ts",
  "src/lib/prisma.ts",
  // Alias `@/*` : la résolution des imports en dépend.
  "tsconfig.json",
]

/** Liste statique + `src/lib/email*` + `src/lib/geo/**` tels que présents à BASE_SHA. */
export function importGraphFiles(root: string): string[] {
  const tree = git(root, "ls-tree", "-r", "--name-only", BASE_SHA, "--", "src/lib").split("\n").filter(Boolean)
  const dynamic = tree.filter((p) => /^src\/lib\/email(\.|\/)/.test(p) || p.startsWith("src/lib/geo/"))
  return Array.from(new Set([...STATIC_IMPORT_GRAPH, ...dynamic])).sort()
}

// ---- Gardes -------------------------------------------------------------------------------------

type Guard = { id: string; ok: boolean; detail: string }

function guardHead(root: string): Guard {
  const head = git(root, "rev-parse", "HEAD")
  return head === BASE_SHA
    ? { id: "a", ok: true, detail: `HEAD = ${head}` }
    : { id: "a", ok: false, detail: `HEAD = ${head} ≠ BASE_SHA ${BASE_SHA}` }
}

function packageJsonDiffOffending(root: string): string[] {
  const diff = git(root, "diff", "HEAD", "-U0", "--", "package.json")
  return diff
    .split("\n")
    .filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"))
    .filter((l) => !/"test:chantiers":/.test(l))
}

function guardTrackedChanges(root: string): Guard {
  // Sortie NON rognée : la première colonne de `--porcelain` peut être un espace (" M path").
  const status = gitBytes(root, "status", "--porcelain=v1", "--untracked-files=all").toString("utf8")
  const offending: string[] = []
  for (const line of status.split("\n").filter(Boolean)) {
    const xy = line.slice(0, 2)
    if (xy === "??") continue // non suivi : garde (c)
    const rawPath = line.slice(3)
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ")[1] : rawPath
    if (path.startsWith("tests/chantiers/parity/")) continue
    if (path === "package.json") {
      const bad = packageJsonDiffOffending(root)
      if (bad.length === 0) continue
      offending.push(`package.json (lignes hors test:chantiers : ${bad.map((b) => JSON.stringify(b)).join(" ")})`)
      continue
    }
    offending.push(`${xy.trim() || "?"} ${path}`)
  }
  return offending.length === 0
    ? { id: "b", ok: true, detail: "aucune modification suivie hors tests/chantiers/parity/** et package.json (test:chantiers)" }
    : { id: "b", ok: false, detail: `modification(s) suivie(s) interdite(s) : ${offending.join(" ; ")}` }
}

function guardUntracked(root: string): Guard {
  const out = git(root, "ls-files", "--others", "--exclude-standard", "--", "src", "prisma", "next.config.ts")
  const files = out.split("\n").filter(Boolean)
  return files.length === 0
    ? { id: "c", ok: true, detail: "aucun fichier non suivi sous src/**, prisma/**, next.config.ts" }
    : { id: "c", ok: false, detail: `fichier(s) non suivi(s) interdit(s) : ${files.join(", ")}` }
}

function guardFingerprints(root: string): { guard: Guard; fingerprints: Record<string, string> } {
  const fingerprints: Record<string, string> = {}
  const mismatches: string[] = []
  for (const path of importGraphFiles(root)) {
    const base = sha256(gitBytes(root, "show", `${BASE_SHA}:${path}`))
    fingerprints[path] = base
    const abs = join(root, path)
    if (!existsSync(abs)) {
      mismatches.push(`${path} (absent du worktree)`)
      continue
    }
    const working = sha256(readFileSync(abs))
    if (working !== base) mismatches.push(`${path} (worktree ${working.slice(0, 12)}… ≠ BASE_SHA ${base.slice(0, 12)}…)`)
  }
  const n = Object.keys(fingerprints).length
  return {
    fingerprints,
    guard:
      mismatches.length === 0
        ? { id: "d", ok: true, detail: `${n} fichiers du graphe d'import identiques à git show BASE_SHA` }
        : { id: "d", ok: false, detail: `empreinte(s) différente(s) de BASE_SHA : ${mismatches.join(" ; ")}` },
  }
}

// ---- Programme -----------------------------------------------------------------------------------

function fail(message: string, code = 1): never {
  console.error(`[record-reference] REFUS — ${message}`)
  process.exit(code)
}

async function main(): Promise<void> {
  const tz = process.env.TZ
  if (!tz || !SUPPORTED_TZ[tz]) {
    fail(`TZ doit valoir ${Object.keys(SUPPORTED_TZ).join(" ou ")} (reçu : ${JSON.stringify(tz)})`, 2)
  }
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (resolvedTimeZone !== tz) fail(`fuseau effectif ${resolvedTimeZone} ≠ TZ=${tz}`, 2)

  const root = git(process.cwd(), "rev-parse", "--show-toplevel")
  if (resolve(process.cwd()) !== resolve(root)) fail(`à exécuter depuis la racine du dépôt (${root})`, 2)

  const gitRef = git(root, "rev-parse", "--abbrev-ref", "HEAD")
  if (gitRef !== "HEAD") {
    console.warn(`[record-reference] avertissement — HEAD n'est pas détaché (branche ${gitRef}) : le worktree de capture attendu est le checkout de référence détaché sur BASE_SHA`)
  }

  const guards: Guard[] = []
  guards.push(guardHead(root))
  guards.push(guardTrackedChanges(root))
  guards.push(guardUntracked(root))
  const fp = guardFingerprints(root)
  guards.push(fp.guard)
  for (const g of guards) console.log(`[garde ${g.id}] ${g.ok ? "OK" : "REFUS"} — ${g.detail}`)
  if (guards.some((g) => !g.ok)) fail("intégrité des sources non établie, aucune référence enregistrée")

  const outDir = join(root, REFERENCE_DIR)
  const manifestPath = join(outDir, "MANIFEST.json")
  const fileFor = (id: string) => referenceFileName(id, tz)
  const existing = CASES.map((c) => fileFor(c.id)).filter((f) => existsSync(join(outDir, f)))
  if (existing.length > 0) fail(`snapshot(s) déjà présent(s) pour TZ=${tz}, jamais régénérés : ${existing.join(", ")}`)

  type Manifest = {
    lot: string
    BASE_SHA: string
    frozenClock: string
    moduleMocking: string
    doubledModules: string[]
    importGraphFingerprints: Record<string, string>
    captures: Record<string, unknown>
  }
  let manifest: Manifest
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
    if (manifest.BASE_SHA !== BASE_SHA) fail(`MANIFEST.json porte BASE_SHA ${manifest.BASE_SHA} ≠ ${BASE_SHA}`)
    if (stableJson(manifest.importGraphFingerprints) !== stableJson(fp.fingerprints)) fail("MANIFEST.json : empreintes du graphe d'import différentes de celles calculées")
    if (manifest.captures[tz]) fail(`MANIFEST.json : capture déjà consignée pour TZ=${tz}`)
  } else {
    manifest = {
      lot: "LOT-1W-1a",
      BASE_SHA,
      frozenClock: FROZEN_CLOCK_ISO,
      moduleMocking: "node:test mock.module (drapeau --experimental-test-module-mocks), chargement TypeScript par tsx (--import tsx), fichiers .ts traités en CommonJS",
      doubledModules: [...DOUBLED_MODULES],
      importGraphFingerprints: fp.fingerprints,
      captures: {},
    }
  }

  let actions: ActionsModule
  try {
    actions = await loadActions()
  } catch (err) {
    fail(`échec de chargement de src/lib/actions/chantier.actions.ts — aucune référence valide : ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof actions.createChantier !== "function" || typeof actions.affecterEquipe !== "function") {
    fail("le module chargé n'exporte pas createChantier et affecterEquipe")
  }

  mkdirSync(outDir, { recursive: true })
  const written: { id: string; action: string; file: string; sha256: string }[] = []
  for (const c of CASES) {
    const first: CaseRecord = await runCase(actions, c)
    const second: CaseRecord = await runCase(actions, c)
    const json = stableJson(first)
    if (json !== stableJson(second)) fail(`cas ${c.id} non reproductible entre deux exécutions — défaut du harnais, pas une référence`)
    const file = fileFor(c.id)
    writeFileSync(join(outDir, file), json)
    written.push({ id: c.id, action: c.action, file, sha256: sha256(json) })
    const outcome = "threw" in first.result ? `threw ${first.result.threw.name}: ${first.result.threw.message}` : `returned ${JSON.stringify(first.result.returned)}`
    console.log(`[cas] ${c.id} — ${first.trace.length} entrées de trace — ${outcome.slice(0, 110)}`)
  }

  manifest.captures[tz] = {
    generatedAt: REAL_STARTED_AT,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tz,
    resolvedTimeZone,
    gitRef,
    command: `TZ=${tz} ${RECORD_COMMAND}`,
    caseCount: written.length,
    cases: written,
  }
  writeFileSync(manifestPath, stableJson(manifest))
  console.log(`[record-reference] ${written.length} références écrites sous ${REFERENCE_DIR} (TZ=${tz}) ; MANIFEST.json mis à jour`)
}

main().catch((err) => {
  console.error("[record-reference] ERREUR —", err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
