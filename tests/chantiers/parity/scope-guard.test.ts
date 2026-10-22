/**
 * LOT-1W-1a — T-CORE-5 : garde de périmètre (fiche rév. 3, §4 et §9.2).
 *
 * Compare le worktree courant au BASE_SHA figé (pas à `origin/main` mouvant) :
 *   - `git diff --name-only BASE_SHA` et `git ls-files --others --exclude-standard` ⊆ liste fermée §2 ;
 *   - `prisma/schema.prisma` et `prisma/migrations/` byte-identiques, aucun fichier non suivi sous prisma/ ;
 *   - rien sous `src/lib/agent-gateway/`, `src/app/api/`, `src/middleware.ts`, `next.config.ts` ;
 *   - `package.json` : seule la ligne `test:chantiers` diffère, dépendances identiques ;
 *   - `"use server"` uniquement dans `chantier.actions.ts`, jamais dans un `*.core.ts` (invariant 6) ;
 *   - tests préexistants `tests/chantiers/*` inchangés (T-CORE-4) ;
 *   - MANIFEST.json cohérent avec BASE_SHA : empreintes du graphe d'import = `git show BASE_SHA`,
 *     snapshots présents, non altérés (SHA-256), jamais régénérés (aucun fichier non listé), deux fuseaux.
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { BASE_SHA, REFERENCE_DIR, SUPPORTED_TZ } from "./harness"

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}
function gitBytes(...args: string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] })
}
function lines(s: string): string[] {
  return s.split("\n").filter(Boolean)
}
function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

/** Liste fermée (fiche §2). */
const ALLOWED_FILES = new Set([
  "src/lib/actions/chantier-create.core.ts",
  "src/lib/actions/assignment-team.core.ts",
  "src/lib/actions/chantier.actions.ts",
  "src/lib/actions/write-actor.ts",
  "tests/chantiers/chantier-create.core.test.ts",
  "tests/chantiers/assignment-team.core.test.ts",
  "package.json",
  "docs/specs/agent-gateway/LOT-1W-1a.md",
])
const ALLOWED_PREFIXES = ["tests/chantiers/parity/"]

function isAllowed(path: string): boolean {
  return ALLOWED_FILES.has(path) || ALLOWED_PREFIXES.some((p) => path.startsWith(p))
}

const changed = lines(git("diff", "--name-only", BASE_SHA))
const untracked = lines(git("ls-files", "--others", "--exclude-standard"))

describe("T-CORE-5 — garde de périmètre contre BASE_SHA figé", () => {
  it("BASE_SHA est un ancêtre (ou égal) de HEAD", () => {
    execFileSync("git", ["merge-base", "--is-ancestor", BASE_SHA, "HEAD"], { cwd: ROOT })
  })

  it("git diff --name-only BASE_SHA ne touche que la liste fermée §2", () => {
    const outside = changed.filter((p) => !isAllowed(p))
    assert.deepEqual(outside, [], `fichiers modifiés hors liste fermée : ${outside.join(", ")}`)
  })

  it("aucun fichier non suivi hors liste fermée §2", () => {
    const outside = untracked.filter((p) => !isAllowed(p))
    assert.deepEqual(outside, [], `fichiers non suivis hors liste fermée : ${outside.join(", ")}`)
  })

  it("prisma/schema.prisma et prisma/migrations/ byte-identiques à BASE_SHA, aucun fichier non suivi", () => {
    assert.equal(git("diff", "--name-only", BASE_SHA, "--", "prisma"), "")
    assert.equal(git("ls-files", "--others", "--exclude-standard", "--", "prisma"), "")
    assert.equal(sha256(readFileSync(join(ROOT, "prisma/schema.prisma"))), sha256(gitBytes("show", `${BASE_SHA}:prisma/schema.prisma`)))
  })

  it("rien sous src/lib/agent-gateway/, src/app/api/, src/middleware.ts, next.config.ts", () => {
    const forbidden = ["src/lib/agent-gateway/", "src/app/api/", "src/middleware.ts", "next.config.ts"]
    const hits = [...changed, ...untracked].filter((p) => forbidden.some((f) => p === f || p.startsWith(f)))
    assert.deepEqual(hits, [])
  })

  it("package.json : seule la ligne test:chantiers diffère ; aucune dépendance ajoutée, retirée ou modifiée", () => {
    const diff = git("diff", BASE_SHA, "-U0", "--", "package.json")
    const bad = lines(diff).filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).filter((l) => !/"test:chantiers":/.test(l))
    assert.deepEqual(bad, [], `lignes de package.json hors test:chantiers : ${bad.join(" | ")}`)
    const base = JSON.parse(gitBytes("show", `${BASE_SHA}:package.json`).toString("utf8")) as Record<string, unknown>
    const now = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>
    assert.deepEqual(now.dependencies, base.dependencies)
    assert.deepEqual(now.devDependencies, base.devDependencies)
  })

  it("\"use server\" figure dans chantier.actions.ts et dans aucun fichier du lot (*.core.ts, write-actor.ts)", () => {
    // Invariant 6 limité aux fichiers du lot : `acquisition-conversion.actions.core.ts` (préexistant,
    // hors périmètre) contient déjà "use server" à BASE_SHA — constat consigné, non corrigé.
    // Directive en début de ligne (pas une simple mention dans un commentaire).
    const DIRECTIVE = /^\s*(["'])use server\1\s*;?\s*$/m
    const actionsDir = join(ROOT, "src/lib/actions")
    const actions = readFileSync(join(actionsDir, "chantier.actions.ts"), "utf8")
    assert.match(actions, /^"use server"/, "chantier.actions.ts doit commencer par \"use server\"")
    for (const f of ["chantier-create.core.ts", "assignment-team.core.ts", "write-actor.ts"]) {
      const abs = join(actionsDir, f)
      if (!existsSync(abs)) continue // absent avant le refactor (commit n° 1)
      assert.doesNotMatch(readFileSync(abs, "utf8"), DIRECTIVE, `${f} ne doit pas contenir la directive "use server"`)
    }
  })

  it("T-CORE-4 : tests préexistants tests/chantiers/* inchangés", () => {
    const preexisting = lines(git("ls-tree", "-r", "--name-only", BASE_SHA, "--", "tests/chantiers"))
    assert.ok(preexisting.length >= 5)
    const touched = changed.filter((p) => preexisting.includes(p))
    assert.deepEqual(touched, [], `tests préexistants modifiés : ${touched.join(", ")}`)
  })

  describe("MANIFEST.json : références figées sur BASE_SHA, jamais régénérées", () => {
    const refDir = join(ROOT, REFERENCE_DIR)
    const manifestPath = join(refDir, "MANIFEST.json")
    type Capture = { tz: string; node: string; command: string; cases: { id: string; file: string; sha256: string }[] }
    type Manifest = { BASE_SHA: string; frozenClock: string; importGraphFingerprints: Record<string, string>; captures: Record<string, Capture> }

    it("présent et porteur du BASE_SHA figé", () => {
      assert.ok(existsSync(manifestPath), `${REFERENCE_DIR}/MANIFEST.json absent`)
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
      assert.equal(m.BASE_SHA, BASE_SHA)
      assert.equal(m.frozenClock, "2026-11-02T08:00:00Z")
    })

    it("empreintes du graphe d'import égales à git show BASE_SHA:<chemin>", () => {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
      const paths = Object.keys(m.importGraphFingerprints)
      assert.ok(paths.includes("src/lib/actions/chantier.actions.ts"))
      assert.ok(paths.includes("src/lib/validations/chantier.ts"))
      for (const p of paths) {
        assert.equal(m.importGraphFingerprints[p], sha256(gitBytes("show", `${BASE_SHA}:${p}`)), `empreinte ${p}`)
      }
    })

    it("captures UTC et Europe/Paris présentes, snapshots existants et non altérés (SHA-256)", () => {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
      for (const tz of Object.keys(SUPPORTED_TZ)) {
        const cap = m.captures[tz]
        assert.ok(cap, `capture TZ=${tz} absente du MANIFEST`)
        assert.ok(cap.cases.length > 0)
        for (const c of cap.cases) {
          const abs = join(refDir, c.file)
          assert.ok(existsSync(abs), `snapshot absent : ${c.file}`)
          assert.equal(sha256(readFileSync(abs)), c.sha256, `snapshot altéré ou régénéré : ${c.file}`)
        }
      }
    })

    it("aucun snapshot non listé dans le MANIFEST (pas de régénération sauvage)", () => {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
      const listed = new Set(Object.values(m.captures).flatMap((c) => c.cases.map((x) => x.file)))
      const onDisk = readdirSync(refDir).filter((f) => f.endsWith(".json") && f !== "MANIFEST.json")
      const stray = onDisk.filter((f) => !listed.has(f))
      assert.deepEqual(stray, [], `snapshots non listés : ${stray.join(", ")}`)
    })
  })
})
