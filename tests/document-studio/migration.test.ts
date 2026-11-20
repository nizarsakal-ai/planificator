/**
 * Lot G Planificator V2 : contrôles statiques (migration additive, index partiels, CHECK et déclencheurs), gardes des
 * pages, actions et PDF, PDF existants non touchés par le module.
 * Portage sur ef36578f (19/11/2026) : migration renumérotée APRÈS la dernière migration de main, SQL v6 identique à
 * l'octet ; gardes de page par refus rendu sur place (studioPageAccess + AdminOnlyNotice) ; signature analysée localement.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_DIR = "20261119130000_v2_lot_g_document_studio"
const sqlBytes = readFileSync(`prisma/migrations/${MIGRATION_DIR}/migration.sql`)
const sql = sqlBytes.toString("utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["document_templates", "document_template_versions", "generated_documents"]
const MARKER = "// Lot G Planificator V2 (04/11/2026"
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const read = (f: string) => readFileSync(f, "utf8")

describe("migration du lot G", () => {
  it("SQL v6 identique à l'octet ; seule migration G ; horodatée après toutes les migrations existantes", () => {
    assert.equal(createHash("sha256").update(sqlBytes).digest("hex"), "7736f8eb60f572c0b254ee0ebe909baa9c26569083c28edb2a6b24e9f2b3a4c5")
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()
    assert.deepEqual(dirs.filter((d) => d.includes("lot_g")), [MIGRATION_DIR])
    // Intégration FGHI : G reste après F et toutes les migrations de la base ; seules H et I la suivent.
    // Seuls les lots H et I suivent G ; les migrations ultérieures (photos, espace PDF du Studio…) ne sont pas des lots.
    assert.deepEqual(dirs.filter((d) => d > MIGRATION_DIR && /_v2_lot_/.test(d)), ["20261119140000_v2_lot_h_payroll_prep", "20261119150000_v2_lot_i_marketing_shop"], "seules H, I après G")
    assert.ok(dirs.includes("20261119120000_v2_lot_f_connectors_assistant") && "20261119120000_v2_lot_f_connectors_assistant" < MIGRATION_DIR, "F avant G")
    assert.ok(dirs.includes("20261117120000_vehicle_tour_auto_km"), "dernière migration de main ef36578f présente")
  })
  it("additive : aucun objet existant modifié, aucune donnée lue ni écrite", () => {
    const body = code(sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$").split("\n").filter((l) => !l.startsWith("--")).join("\n"))
    assert.doesNotMatch(body, /\bDROP\b|ALTER TYPE/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE|BEFORE INSERT ON|BEFORE TRUNCATE ON/g, ""), /\bTRUNCATE\b|\bINSERT\b/i)
    assert.doesNotMatch(body.replace(/BEFORE (?:INSERT OR )?UPDATE OR DELETE/g, "").replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, ""), /\bUPDATE\b|\bDELETE\b/i)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/ON "([a-z_]+)"\s+(?:DEFERRABLE|FOR EACH)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("un seul brouillon et une seule version publiée par modèle ; clés composites ; aucune cascade", () => {
    assert.match(sql, /CREATE UNIQUE INDEX "document_template_versions_one_draft" ON "document_template_versions"\("templateId"\) WHERE "status" = 'DRAFT';/)
    assert.match(sql, /CREATE UNIQUE INDEX "document_template_versions_one_published" ON "document_template_versions"\("templateId"\) WHERE "status" = 'PUBLISHED';/)
    for (const re of [
      /"document_template_versions_companyId_templateId_fkey" FOREIGN KEY \("companyId", "templateId"\) REFERENCES "document_templates"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"generated_documents_companyId_versionId_fkey" FOREIGN KEY \("companyId", "versionId"\) REFERENCES "document_template_versions"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"generated_documents_clientId_companyId_fkey" FOREIGN KEY \("clientId", "companyId"\) REFERENCES "clients"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"generated_documents_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
      /CREATE UNIQUE INDEX "generated_documents_companyId_number_key" ON "generated_documents"\("companyId", "number"\);/,
      /CREATE UNIQUE INDEX "document_templates_companyId_name_key" ON "document_templates"\("companyId", "name"\);/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    assert.ok(schema.includes(MARKER), "marqueur du lot G présent")
    assert.doesNotMatch(schema.split(MARKER)[1], /onDelete: Cascade/)
  })
  it("CHECK et déclencheurs : version figée, document né d'une version publiée, validation par un autre utilisateur", () => {
    assert.match(sql, /AND "signatureSha256" IS NOT NULL AND "signatureSha256" ~ '\^\[0-9a-f\]\{64\}\$' AND "approvedById" <> "createdById"\)/)
    for (const st of ["PUBLISHED", "RETIRED"]) assert.match(sql, new RegExp(`\\("status" = '${st}' AND "contentSha256" IS NOT NULL AND "contentSha256" ~ `), `IS NOT NULL explicite (${st})`)
    for (const m of ["document template version must start as draft", "published document template version immutable", "document template version status transition not allowed", "generated document requires a published version", "generated document initial status mismatch", "generated document content immutable", "generated document already decided", "document template cannot be deleted", "generated document cannot be deleted"]) assert.ok(sql.includes(m), m)
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
  })
})

describe("gardes et périmètre", () => {
  it("pages, actions et PDF passent par leur garde ; aucun companyId lu du client", () => {
    for (const f of ["src/app/(dashboard)/studio-documents/page.tsx", "src/app/(dashboard)/studio-documents/[templateId]/page.tsx", "src/app/(dashboard)/studio-documents/documents/[id]/page.tsx"]) {
      const c = code(read(f))
      assert.match(c, /const ctx = await studioPageAccess\(\)\n\s+if \(!ctx\) return <AdminOnlyNotice \/>\n/, `${f} : refus rendu sur place, première instruction après la garde`)
      const garde = c.indexOf("if (!ctx) return <AdminOnlyNotice />")
      for (const lecture of ["prisma.", "listTemplates(", "listGeneratedDocuments(", "getTemplate(", "getGeneratedDocumentView(", "await params", "await searchParams"]) {
        const at = c.indexOf(lecture)
        if (at >= 0) assert.ok(at > garde, `${f} : ${lecture} après la garde`)
      }
      assert.doesNotMatch(c, /requireStudioPage|redirect\(/, `${f} : aucune redirection vers /dashboard`)
    }
    const access = read("src/lib/document-studio/access.ts")
    assert.ok(access.includes("const decision = pageDecision(r.reason)"), "décision de page partagée avec les lots A et B")
    assert.doesNotMatch(code(access), /redirect\("\/dashboard"\)/)
    const pdf = read("src/app/(dashboard)/studio-documents/documents/[id]/pdf/route.tsx")
    assert.match(pdf, /const access = await resolveStudioAccess\(\)\n\s+if \(!access\.ok\) return none\(studioDenialStatus\(access\.reason\)\)/)
    assert.match(pdf, /if \(!d\.intact \|\| !d\.snapshot\) \{[\s\S]*?return none\(409\)/, "empreinte non conforme ⇒ 409")
    const a = read("src/lib/actions/document-studio.actions.ts")
    assert.match(a, /^"use server"/)
    assert.match(a, /await requireStudioAdmin\(\)/)
    assert.doesNotMatch(code(a), /companyId:\s*(?:str|form|reqId)/)
    assert.doesNotMatch(code(a), /revalidatePath|safePath|back\(/, "retour explicite E4 : plus de redirection serveur de succès")
  })
  it("PDF existants : le module ne les importe ni ne les modifie ; le PDF du studio ne lit que l'instantané", () => {
    const files = readdirSync("src/lib/document-studio").map((f) => `src/lib/document-studio/${f}`)
    for (const f of files) assert.doesNotMatch(read(f), /@\/app\/api\/pdf|api\/pdf\//, f)
    const pdfDoc = code(read("src/lib/document-studio/document-pdf.tsx"))
    assert.doesNotMatch(pdfDoc, /prisma|@\/lib\/prisma|findFirst|findMany/, "aucune lecture de données vivantes dans le rendu")
  })
  it("validation par un autre administrateur, signature contrôlée localement (règles v6) ; layout conditionné", () => {
    const svc = read("src/lib/document-studio/studio.service.ts")
    assert.match(svc, /if \(d\.createdById === ctx\.userId\) fail\(STUDIO_ERRORS\.selfApproval\)/)
    assert.match(svc, /const sig = parseStudioSignature\(input\.signature\)/)
    assert.match(svc, /AND "status" = 'PUBLISHED' FOR SHARE`/)
    assert.ok(read("src/app/(dashboard)/layout.tsx").includes(`const documentStudioNavVisible = isDocumentStudioEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId`))
  })
})
