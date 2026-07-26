/**
 * LOT-1A STEP-5 — architecture : imports interdits + couches.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(process.cwd(), "src/lib/integration")

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /@prisma\/client/,
  /@\/lib\/prisma\b/,
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
  /\/persistence\b/,
  /connectors\/mail-bridge/,
]

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTsFiles(full))
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full)
  }
  return out.sort()
}

function extractImportSpecifiers(source: string): string[] {
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

function layerOf(filePath: string): "types" | "contracts" | "registry" | "other" {
  const rel = path.relative(ROOT, filePath).replace(/\\/g, "/")
  if (rel.startsWith("types/")) return "types"
  if (rel.startsWith("contracts/")) return "contracts"
  if (rel.startsWith("registry/")) return "registry"
  return "other"
}

describe("LOT-1A no forbidden imports", () => {
  const files = collectTsFiles(ROOT)

  it("scanne uniquement le périmètre LOT-1A", () => {
    assert.ok(files.length >= 24)
    for (const file of files) {
      assert.ok(file.startsWith(ROOT))
    }
  })

  it("n’importe pas de modules métier / provider / app interdits", () => {
    const violations: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8")
      for (const spec of extractImportSpecifiers(source)) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(spec)) {
            violations.push(`${path.relative(process.cwd(), file)} -> ${spec}`)
          }
        }
      }
    }
    assert.deepEqual(violations, [])
  })

  it("respecte la dépendance de couches types → contracts → registry", () => {
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
            normalized.includes("lib/integration/contracts") ||
            normalized.includes("lib/integration/registry")
          ) {
            violations.push(
              `${path.relative(process.cwd(), file)} types must not import ${normalized}`
            )
          }
        }
        if (layer === "contracts") {
          if (
            normalized.includes("/integration/registry/") ||
            normalized.includes("lib/integration/registry")
          ) {
            violations.push(
              `${path.relative(process.cwd(), file)} contracts must not import ${normalized}`
            )
          }
        }
      }
    }
    assert.deepEqual(violations, [])
  })
})
