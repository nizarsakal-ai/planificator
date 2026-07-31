/**
 * LOT-1A / LOT-1B1 — architecture : imports interdits + frontières de couches.
 *
 * Zones :
 * - types / contracts / registry : abstraites (pas de Prisma, pas de persistence)
 * - persistence : seule couche autorisée à importer Prisma / client applicatif
 *   et à dépendre des contrats/types LOT-1A
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(process.cwd(), "src/lib/integration")

/** Interdits partout (y compris persistence) — pas de fuite métier / runtime. */
const UNIVERSAL_FORBIDDEN: readonly RegExp[] = [
  /@\/lib\/acquisition\b/,
  /src\/lib\/acquisition\b/,
  /@\/lib\/booking\b/,
  /src\/lib\/booking\b/,
  /\bgmail\b/i,
  /\boauth\b/i,
  /@\/lib\/.*review/i,
  /\breview\b/i,
  /\bconversion\b/i,
  /\bextraction\b/i,
  /\banthropic\b/i,
  /\bcron\b/i,
  /@\/app\b/,
  /src\/app\b/,
  /@\/components\b/,
  /src\/components\b/,
  /@\/lib\/actions\b/,
  /src\/lib\/actions\b/,
  /connectors\/mail-bridge/,
]

const PRISMA_FORBIDDEN: readonly RegExp[] = [
  /@prisma\/client/,
  /@\/lib\/prisma\b/,
]

export type IntegrationLayer =
  | "types"
  | "contracts"
  | "registry"
  | "persistence"
  | "other"

export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

export function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full)
  }
  return out.sort()
}

export function extractImportSpecifiers(source: string): string[] {
  const cleaned = stripComments(source)
  const specs: string[] = []
  const staticImport =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+|)\s*["']([^"']+)["']/g
  const sideEffect = /import\s*["']([^"']+)["']/g
  const dynamic = /import\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const re of [staticImport, sideEffect, dynamic]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(cleaned)) !== null) {
      specs.push(match[1]!)
    }
  }
  return specs
}

export function layerOf(filePath: string): IntegrationLayer {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, "/")
  if (rel.startsWith("types/")) return "types"
  if (rel.startsWith("contracts/")) return "contracts"
  if (rel.startsWith("registry/")) return "registry"
  if (rel.startsWith("persistence/")) return "persistence"
  return "other"
}

/** Spec d’import → chemin sous ROOT si résolu dans le package integration. */
export function resolveImportUnderRoot(
  fromFile: string,
  spec: string
): string | null {
  const normalized = spec.replace(/\\/g, "/")

  if (
    normalized.startsWith("@/lib/integration/") ||
    normalized.startsWith("src/lib/integration/")
  ) {
    const suffix = normalized
      .replace(/^@\/lib\/integration\//, "")
      .replace(/^src\/lib\/integration\//, "")
    return path.resolve(ROOT, suffix)
  }

  if (normalized.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), normalized)
  }

  return null
}

export function isPersistenceTarget(
  fromFile: string,
  spec: string
): boolean {
  const normalized = spec.replace(/\\/g, "/")
  if (
    /\/persistence\b/.test(normalized) ||
    /@\/lib\/integration\/persistence\b/.test(normalized) ||
    /src\/lib\/integration\/persistence\b/.test(normalized)
  ) {
    return true
  }

  const resolved = resolveImportUnderRoot(fromFile, spec)
  if (!resolved) return false
  const rel = path.relative(ROOT, resolved).replace(/\\/g, "/")
  return rel === "persistence" || rel.startsWith("persistence/")
}

export function isPrismaImport(spec: string): boolean {
  return PRISMA_FORBIDDEN.some((pattern) => pattern.test(spec))
}

/**
 * Politique d’import pour une couche donnée.
 * Retourne un message de violation ou null si autorisé.
 */
export function violationForImport(
  layer: IntegrationLayer,
  fromFile: string,
  spec: string
): string | null {
  for (const pattern of UNIVERSAL_FORBIDDEN) {
    if (pattern.test(spec)) {
      return `interdit universel: ${spec}`
    }
  }

  const prisma = isPrismaImport(spec)
  const toPersistence = isPersistenceTarget(fromFile, spec)

  if (layer === "persistence") {
    // Prisma + client applicatif OK ; imports intra-persistence OK ;
    // contracts/types OK (pas vérifiés ici comme interdits).
    return null
  }

  // Couches abstraites / autres : Prisma et persistence interdits.
  if (prisma) {
    return `Prisma interdit hors persistence: ${spec}`
  }
  if (toPersistence) {
    return `persistence interdit hors couche persistence: ${spec}`
  }
  return null
}

function scanLayerViolations(
  files: string[]
): string[] {
  const violations: string[] = []
  for (const file of files) {
    const layer = layerOf(file)
    const source = fs.readFileSync(file, "utf8")
    for (const spec of extractImportSpecifiers(source)) {
      const reason = violationForImport(layer, file, spec)
      if (reason) {
        violations.push(
          `${path.relative(process.cwd(), file)} -> ${spec} (${reason})`
        )
      }
    }
  }
  return violations
}

describe("Integration architecture — frontières LOT-1A / LOT-1B1 / LOT-1B2", () => {
  const files = collectTsFiles(ROOT)
  const abstractFiles = files.filter((f) => layerOf(f) !== "persistence")
  const persistenceFiles = files.filter((f) => layerOf(f) === "persistence")

  it("scanne le périmètre integration (LOT-1A + persistence LOT-1B1/1B2)", () => {
    assert.ok(files.length >= 24)
    for (const file of files) {
      assert.ok(file.startsWith(ROOT))
    }
    assert.ok(
      persistenceFiles.length >= 8,
      "LOT-1B1+1B2 persistence attendue sous src/lib/integration/persistence/"
    )
  })

  it("n’autorise Prisma / client Prisma que dans persistence", () => {
    const violations = scanLayerViolations(files)
    assert.deepEqual(violations, [])
  })

  it("respecte types → contracts → registry (sans remonter)", () => {
    const violations: string[] = []
    for (const file of files) {
      const layer = layerOf(file)
      const source = fs.readFileSync(file, "utf8")
      for (const spec of extractImportSpecifiers(source)) {
        const normalized = spec.replace(/\\/g, "/")
        if (layer === "types") {
          if (
            normalized.includes("/integration/contracts/") ||
            normalized.includes("/integration/registry/") ||
            normalized.includes("/integration/persistence/") ||
            normalized.includes("lib/integration/contracts") ||
            normalized.includes("lib/integration/registry") ||
            normalized.includes("lib/integration/persistence")
          ) {
            violations.push(
              `${path.relative(process.cwd(), file)} types must not import ${normalized}`
            )
          }
        }
        if (layer === "contracts") {
          if (
            normalized.includes("/integration/registry/") ||
            normalized.includes("/integration/persistence/") ||
            normalized.includes("lib/integration/registry") ||
            normalized.includes("lib/integration/persistence")
          ) {
            violations.push(
              `${path.relative(process.cwd(), file)} contracts must not import ${normalized}`
            )
          }
        }
        if (layer === "registry") {
          if (
            normalized.includes("/integration/persistence/") ||
            normalized.includes("lib/integration/persistence")
          ) {
            violations.push(
              `${path.relative(process.cwd(), file)} registry must not import ${normalized}`
            )
          }
        }
      }
    }
    assert.deepEqual(violations, [])
  })

  it("accepte un import Prisma dans persistence (politique)", () => {
    const fakePersistence = path.join(ROOT, "persistence", "fixture.ts")
    assert.equal(
      violationForImport("persistence", fakePersistence, "@prisma/client"),
      null
    )
    assert.equal(
      violationForImport("persistence", fakePersistence, "@/lib/prisma"),
      null
    )
  })

  it("rejette un import Prisma dans contracts (politique)", () => {
    const fakeContract = path.join(ROOT, "contracts", "fixture.ts")
    const v1 = violationForImport("contracts", fakeContract, "@prisma/client")
    const v2 = violationForImport("contracts", fakeContract, "@/lib/prisma")
    assert.ok(v1 && v1.includes("Prisma"))
    assert.ok(v2 && v2.includes("Prisma"))
  })

  it("rejette un import persistence depuis contracts (politique + relatif)", () => {
    const fakeContract = path.join(ROOT, "contracts", "fixture.ts")
    const alias = violationForImport(
      "contracts",
      fakeContract,
      "@/lib/integration/persistence/integration-connection.repository"
    )
    const relative = violationForImport(
      "contracts",
      fakeContract,
      "../persistence/integration-connection.repository"
    )
    assert.ok(alias && alias.includes("persistence"))
    assert.ok(relative && relative.includes("persistence"))
  })

  it("rejette un import persistence depuis registry (politique)", () => {
    const fakeRegistry = path.join(ROOT, "registry", "fixture.ts")
    const v = violationForImport(
      "registry",
      fakeRegistry,
      "@/lib/integration/persistence/integration-connection.mapper"
    )
    assert.ok(v && v.includes("persistence"))
  })

  it("accepte un import contracts depuis persistence (politique)", () => {
    const fakePersistence = path.join(ROOT, "persistence", "fixture.ts")
    assert.equal(
      violationForImport(
        "persistence",
        fakePersistence,
        "@/lib/integration/contracts/integration-connection"
      ),
      null
    )
  })

  it("les repositories LOT-1B1 / LOT-1B2 réels ne sont pas des faux positifs Prisma", () => {
    const repos = [
      "integration-connection.repository.ts",
      "inbound-envelope.repository.ts",
      "normalized-inbound.repository.ts",
    ]
    for (const name of repos) {
      const repo = path.join(ROOT, "persistence", name)
      assert.ok(fs.existsSync(repo), `repository attendu: ${name}`)
      const source = fs.readFileSync(repo, "utf8")
      const specs = extractImportSpecifiers(source)
      assert.ok(
        specs.some((s) => s === "@prisma/client" || s === "@/lib/prisma"),
        `${name} doit importer Prisma`
      )
      for (const spec of specs) {
        assert.equal(
          violationForImport("persistence", repo, spec),
          null,
          `faux positif ${name}: ${spec}`
        )
      }
    }
  })

  it("aucune couche abstraite du tree n’importe Prisma ni persistence", () => {
    for (const file of abstractFiles) {
      const source = fs.readFileSync(file, "utf8")
      for (const spec of extractImportSpecifiers(source)) {
        assert.equal(
          isPrismaImport(spec),
          false,
          `${path.relative(process.cwd(), file)} importe Prisma: ${spec}`
        )
        assert.equal(
          isPersistenceTarget(file, spec),
          false,
          `${path.relative(process.cwd(), file)} importe persistence: ${spec}`
        )
      }
    }
  })
})
