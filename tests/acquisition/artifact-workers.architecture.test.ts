/**
 * LOT-4B — frontières des workers contenu / pièces jointes (plan §16, critère LOT-4 ; §16.5 « no Provider in core »).
 * Les services n'importent aucun adaptateur ni client fournisseur : ils passent par le résolveur d'artefacts.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../..")
const WORKERS = [
  "src/lib/acquisition/content/message-content.service.ts",
  "src/lib/acquisition/attachments/attachment-download.service.ts",
]
const FORBIDDEN = [
  /gmail/i,
  /googleapis/i,
  /@\/lib\/acquisition\/connector\//,
  /legacy-mail-artifact-sources/,
]

function importsOf(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8")
  return [...src.matchAll(/(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
}

describe("workers LOT-4 : aucun type ni adaptateur fournisseur", () => {
  for (const file of WORKERS) {
    it(file, () => {
      const imports = importsOf(file)
      assert.ok(imports.length > 0, "imports lus")
      const violations = imports.filter((spec) => FORBIDDEN.some((re) => re.test(spec)))
      assert.deepEqual(violations, [])
      assert.ok(imports.includes("@/lib/acquisition/artifacts/resolve-mail-artifact-provider"), "passe par le résolveur")
    })
  }

  it("le détecteur repère bien un import interdit", () => {
    const fake = 'import { x } from "@/lib/acquisition/connector/gmail-api.client"'
    const spec = /from\s+["']([^"']+)["']/.exec(fake)![1]
    assert.ok(FORBIDDEN.some((re) => re.test(spec)))
  })

  it("seul le module de composition historique assemble les adaptateurs Gmail", () => {
    const imports = importsOf("src/lib/acquisition/artifacts/legacy-mail-artifact-sources.ts")
    assert.ok(imports.some((s) => /gmail/i.test(s)))
    const resolver = importsOf("src/lib/acquisition/artifacts/resolve-mail-artifact-provider.ts")
    assert.deepEqual(resolver.filter((s) => /gmail-(api|message|attachment)/i.test(s)), [])
  })
})
