/**
 * Lot D Planificator V2 : contrôles statiques (migration additive, clés composites, CHECK, déclencheurs) et gardes
 * des trois modules du lot (réserves, recherche, indicateurs commerciaux), tous désactivés par défaut.
 * Réconciliation 12/11 sur l'arbre publié b0a2523e : migration renumérotée après le lot C, aucune clé vers RH, refus de
 * page rendu sur place, plafond de 500 réserves par procès-verbal, limite de débit de la recherche.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"
import { resolveReserveAccessCore } from "@/lib/reserves/access"
import { isWorksiteReservesEnabled } from "@/lib/reserves/reserves-feature-flag"
import { isSalesDashboardEnabled } from "@/lib/sales-dashboard/sales-feature-flag"

const D = "20261112120000_v2_lot_d_reserves_reception"
// Empreinte du SQL D qualifié en laboratoire.
const SHA_D = "496ecb874b2786df998ecff298ecb4b8379bff7fade91a92239463eee104f660"
const sql = readFileSync(`prisma/migrations/${D}/migration.sql`, "utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["worksite_reserves", "worksite_reserve_files", "reception_reports", "reception_report_reserves"]
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const read = (f: string) => readFileSync(f, "utf8")

describe("migration du lot D", () => {
  it("purement additive : aucune suppression ni écriture de données, aucune table existante touchée", () => {
    const body = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ … $$")
    assert.doesNotMatch(body, /\bDROP\b/i)
    assert.doesNotMatch(body, /\bTRUNCATE\b(?! ON)|\bINSERT\b(?! ON)/i)
    assert.doesNotMatch(body.replace(/BEFORE UPDATE OR DELETE/g, "").replace(/ON (?:DELETE|UPDATE) (?:RESTRICT|CASCADE)/g, ""), /\bUPDATE\b|\bDELETE\b/i)
    for (const m of body.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    for (const m of body.matchAll(/ON "([a-z_]+)"\s+(?:DEFERRABLE|FOR EACH)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1])
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("clés composites d'entreprise, jamais de cascade de suppression", () => {
    for (const t of NEW_TABLES) assert.match(sql.split(`CREATE TABLE "${t}" (`)[1].split(");")[0], /"companyId" TEXT NOT NULL/, t)
    for (const re of [
      /"worksite_reserves_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"worksite_reserve_files_companyId_reserveId_fkey" FOREIGN KEY \("companyId", "reserveId"\) REFERENCES "worksite_reserves"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"reception_reports_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\) ON DELETE RESTRICT/,
      /"reception_report_reserves_companyId_reportId_fkey" FOREIGN KEY \("companyId", "reportId"\) REFERENCES "reception_reports"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"reception_report_reserves_companyId_reserveId_fkey" FOREIGN KEY \("companyId", "reserveId"\) REFERENCES "worksite_reserves"\("companyId", "id"\) ON DELETE RESTRICT/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    const lotD = schema.split("// Lot D Planificator V2 (04/11/2026")[1]
    assert.ok(lotD)
    assert.doesNotMatch(lotD, /onDelete: Cascade/)
  })
  it("aucune référence RH : ni clé vers employees, ni relation Prisma vers Employee ; responsable = libellé libre borné", () => {
    assert.doesNotMatch(sql, /REFERENCES "employees"/)
    assert.doesNotMatch(sql, /assigneeEmployeeId/)
    assert.match(sql, /"assigneeLabel" TEXT,/)
    assert.match(sql, /\("assigneeLabel" IS NULL OR length\(btrim\("assigneeLabel"\)\) BETWEEN 1 AND 120\)/)
    const lotD = schema.split("// Lot D Planificator V2 (04/11/2026")[1]
    assert.doesNotMatch(lotD, /\bEmployee\b|assigneeEmployeeId/)
    const employee = schema.split("model Employee {")[1].split("\n}")[0]
    assert.doesNotMatch(employee, /WorksiteReserve/)
  })
  it("nom historique unique conservé ; dépendances (A, B, garde, C, tables référencées) antérieures ; aucune collision ; migrations plus récentes indépendantes de D ; SQL D et C inchangés", () => {
    // Intégration sur main 743c5ec2 (23/11) : des migrations indépendantes de main sont plus récentes que D ; « après toutes » devient
    // le contrôle des seules dépendances nécessaires et de la non-collision.
    const dirs = readdirSync("prisma/migrations", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    const stamp = (d: string) => d.slice(0, 14)
    const sqlDe = (d: string) => readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8")
    assert.equal(dirs.filter((d) => d === D).length, 1)
    assert.equal(dirs.some((d) => d.startsWith("20261104150000_")), false, "ancien horodatage absent")
    assert.equal(dirs.filter((d) => d.startsWith(`${stamp(D)}_`)).length, 1, "horodatage unique")
    for (const dep of ["20261110120000_v2_lot_a_stock_purchasing", "20261110130000_v2_lot_b_equipment_rental", "20261110140000_v2_lot_b_booking_overlap_guard", "20261111120000_v2_lot_c_worksite_budgets"]) {
      assert.equal(dirs.filter((d) => d === dep).length, 1, dep)
      assert.ok(stamp(dep) < stamp(D), `${dep} doit précéder le lot D`)
    }
    for (const t of ["companies", "worksites"]) assert.ok(dirs.some((d) => stamp(d) < stamp(D) && sqlDe(d).includes(`CREATE TABLE "${t}"`)), `table référencée ${t} créée avant le lot D`)
    for (const d of dirs.filter((x) => x !== D)) {
      const s = sqlDe(d)
      for (const t of NEW_TABLES) {
        assert.ok(!s.includes(`CREATE TABLE "${t}"`), `${d} : ${t} créée par le seul lot D`)
        if (stamp(d) > stamp(D)) assert.ok(!s.includes(`"${t}"`), `${d} : migration plus récente indépendante du lot D (${t})`)
      }
    }
    assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${D}/migration.sql`)).digest("hex"), SHA_D, "SQL du lot D inchangé")
    assert.equal(createHash("sha256").update(readFileSync("prisma/migrations/20261111120000_v2_lot_c_worksite_budgets/migration.sql")).digest("hex"), "abc86998b82d7671cfc04e79eca6c067d8da468dcf39b773f3179c212d2d6c16", "migration C inchangée")
  })
  it("CHECK : états cohérents, preuves (taille, type, empreinte), signature bornée", () => {
    assert.match(sql, /"status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL/)
    assert.match(sql, /"mime" IN \('image\/jpeg', 'image\/png', 'image\/webp', 'application\/pdf'\)/)
    assert.match(sql, /octet_length\("data"\) = "size"/)
    assert.match(sql, /octet_length\("signaturePng"\) BETWEEN 100 AND 300000/)
    assert.match(sql, /"snapshotSha256" ~ '\^\[0-9a-f\]\{64\}\$'/)
  })
  it("déclencheurs : PV, liens et preuves immuables ; réserve figée une fois close ; inscrite ⇒ non annulable ; cohérence différée", () => {
    for (const t of ["reception_reports", "reception_report_reserves", "worksite_reserve_files"]) {
      assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON "${t}"\\s+FOR EACH ROW EXECUTE FUNCTION reception_history_immutable\\(\\)`), t)
    }
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
    assert.match(sql, /IF OLD\."status" <> 'OPEN' THEN/)
    assert.match(sql, /reserve listed in a reception report cannot be cancelled/)
    assert.match(sql, /CREATE CONSTRAINT TRIGGER reception_reports_consistent AFTER INSERT ON "reception_reports"\s+DEFERRABLE INITIALLY DEFERRED/)
    assert.match(sql, /must list every open reserve of the worksite/)
    assert.match(sql, /IF listed > 500 THEN\n\s+RAISE EXCEPTION 'reception report cannot list more than 500 reserves'/)
  })
})

describe("gardes du lot D", () => {
  it("réserves : pages, PDF, fichiers et actions passent par la garde ; aucun companyId lu du client", () => {
    // D-R16-11 : la fiche chantier vit sous un groupe frère SANS loading.tsx (même URL /reserves/[worksiteId]), avec la
    // coquille V1 réexportée telle quelle ; la garde de page reste vérifiée sur le fichier réellement servi.
    assert.throws(() => read("src/app/(dashboard)/reserves/[worksiteId]/page.tsx"), /ENOENT/, "une seule page pour /reserves/[worksiteId]")
    assert.equal(code(read("src/app/(dashboard-sans-chargement)/layout.tsx")).trim(), `export { default } from "@/app/(dashboard)/layout"`, "coquille V1 réexportée sans modification")
    for (const f of ["src/app/(dashboard-sans-chargement)/loading.tsx", "src/app/(dashboard-sans-chargement)/reserves/loading.tsx"]) assert.throws(() => read(f), /ENOENT/, `${f} : aucun squelette dans le groupe frère`)
    for (const f of ["src/app/(dashboard)/reserves/page.tsx", "src/app/(dashboard-sans-chargement)/reserves/[worksiteId]/page.tsx"]) {
      assert.match(read(f), /const ctx = await reservePageAccess\(\)\n(?:\s*\/\/[^\n]*\n)?\s*if \(!ctx\) return <AdminOnlyNotice \/>/, f)
      assert.doesNotMatch(code(read(f)), /redirect\("\/dashboard"\)/, f)
    }
    for (const f of ["src/app/(dashboard)/reserves/pv/[id]/pdf/route.tsx", "src/app/(dashboard)/reserves/fichiers/[id]/route.ts"]) {
      assert.match(code(read(f)), /const access = await resolveReserveAccess\(\)\n\s+if \(!access\.ok\) return none\(reserveDenialStatus\(access\.reason\)\)/, f)
      assert.match(read(f), /access\.context\.companyId/, f)
    }
    const actions = read("src/lib/actions/reserves.actions.ts")
    assert.match(actions, /^"use server"/)
    assert.match(actions, /const ctx = await requireReserveAdmin\(\)/)
    assert.doesNotMatch(code(actions), /companyId/)
    const files = read("src/app/(dashboard)/reserves/fichiers/[id]/route.ts")
    assert.match(files, /"Content-Disposition": `attachment;/)
    assert.match(files, /"X-Content-Type-Options": "nosniff"/)
    assert.match(files, /"Content-Security-Policy": "sandbox; default-src 'none'"/)
    assert.match(read("src/app/(dashboard)/reserves/pv/[id]/pdf/route.tsx"), /if \(!report\.intact\)/, "empreinte vérifiée avant tout rendu")
  })
  it("verrous : sérialisation réserve / PV par chantier et verrou de ligne bornés à l'entreprise", () => {
    const svc = read("src/lib/reserves/reserves.service.ts")
    assert.match(svc, /const key = `reception:\$\{ctx\.companyId\}:\$\{worksiteId\}`/)
    assert.match(svc, /pg_advisory_xact_lock/)
    assert.match(svc, /await lockWorksiteReception\(tx, ctx, site\.worksiteId\)\n  const rows = await tx\.\$queryRaw/, "levée et annulation : verrou de chantier AVANT le verrou de ligne")
    assert.match(svc, /FROM "worksite_reserves" WHERE "id" = \$\{reserveId\} AND "companyId" = \$\{ctx\.companyId\} FOR UPDATE/)
  })
  it("PDF construit depuis l'instantané seul, métadonnées fixées", () => {
    const pdf = code(read("src/lib/reserves/report-pdf.tsx"))
    assert.doesNotMatch(pdf, /prisma|@\/lib\/prisma|fetch\(/)
    assert.match(pdf, /creationDate=\{new Date\(p\.signedAt\)\}/)
    assert.match(pdf, /pas une signature électronique qualifiée/)
  })
  it("contrainte différée du PV évaluée AVANT le COMMIT (Prisma 5 avale l'erreur du COMMIT) : dernière instruction de la signature", () => {
    const svc = code(read("src/lib/reserves/reserves.service.ts"))
    const sign = svc.split("export async function createReceptionReport")[1]
    assert.match(svc, /import \{ flushDeferredConstraints \} from "@\/lib\/deferred-constraints"/)
    assert.match(sign, /await flushDeferredConstraints\(tx, \["reception_reports_consistent"\]\)\n\s+return \{ id: report\.id, number \}/)
    assert.ok(sign.indexOf("flushDeferredConstraints(") > sign.indexOf("tx.receptionReportReserve.createMany"), "après l'inscription des réserves")
    assert.match(sql, /CREATE CONSTRAINT TRIGGER reception_reports_consistent AFTER INSERT/, "nom de contrainte identique à la migration")
  })
  it("PV jamais tronqué : instantané sans plafond, refus au-delà de 500 avant toute écriture", () => {
    const svc = code(read("src/lib/reserves/reserves.service.ts"))
    const sign = svc.split("export async function createReceptionReport")[1]
    assert.match(sign, /const openCount = await tx\.worksiteReserve\.count\(/)
    assert.match(sign, /if \(openCount > MAX_REPORT_RESERVES\) fail\(RESERVE_ERRORS\.tooManyReserves\)/)
    const read1 = sign.split("const open = await tx.worksiteReserve.findMany(")[1].split("})")[0]
    assert.doesNotMatch(read1, /\btake\b/, "lecture des réserves ouvertes du PV sans plafond")
    assert.ok(sign.indexOf("openCount > MAX_REPORT_RESERVES") < sign.indexOf("tx.receptionReport.create"), "refus avant écriture")
  })
  it("recherche : point d'accès sous drapeau, session et rôle ; companyId et rôle issus de la session", () => {
    const route = code(read("src/app/api/recherche/route.ts"))
    assert.match(route, /if \(!isGlobalSearchEnabled\(\)\) return new NextResponse\(null, \{ status: 404/)
    assert.match(route, /resolveStockAccessCore\(true, session\)/)
    assert.match(route, /companyId: access\.context\.companyId, role: access\.context\.role/)
    assert.ok(route.indexOf("searchRateLimiter.check(access.context.companyId, access.context.userId)") > route.indexOf("resolveStockAccessCore(true, session)"), "limite après la session")
    assert.ok(route.indexOf("searchRateLimiter.check(") < route.indexOf("globalSearch("), "limite AVANT toute requête en base")
    assert.match(route, /status: 429/)
    const service = code(read("src/lib/search/search.service.ts"))
    for (const m of service.matchAll(/db\.(\w+)\.findMany\(\{ where: \{ ([^}]*)/g)) assert.match(m[2], /^companyId,/, `${m[1]} non borné`)
    assert.equal([...service.matchAll(/db\.\w+\.findMany\(/g)].length, 7)
    assert.doesNotMatch(service, /employee/i, "aucune lecture RH")
  })
  it("tableaux de bord : page sous garde ; lectures bornées par companyId", () => {
    assert.match(read("src/app/(dashboard)/tableaux-de-bord/page.tsx"), /const ctx = await salesPageAccess\(\)\n(?:\s*\/\/[^\n]*\n)?\s*if \(!ctx\) return <AdminOnlyNotice \/>/)
    const q = code(read("src/lib/sales-dashboard/queries.ts"))
    for (const m of q.matchAll(/tx\.(\w+)\.findMany\(\{\s*where: \{ ([^}]*)/g)) assert.match(m[2], /companyId/, m[1])
    assert.doesNotMatch(q, /\.(create|update|upsert|delete)(Many)?\(/, "lecture seule de la facturation")
  })
  it("drapeaux \"true\" exact ; garde ADMIN/SUPER_ADMIN ; layout conditionné", () => {
    for (const v of [undefined, "", "TRUE", "1"]) {
      assert.equal(isWorksiteReservesEnabled({ WORKSITE_RESERVES_ENABLED: v }), false)
      assert.equal(isSalesDashboardEnabled({ SALES_DASHBOARD_ENABLED: v }), false)
    }
    assert.deepEqual(resolveReserveAccessCore(true, { user: { id: "u", role: "TEAM_LEADER", companyId: "c" } }), { ok: false, reason: "FORBIDDEN" })
    assert.deepEqual(resolveReserveAccessCore(false, { user: { id: "u", role: "ADMIN", companyId: "c" } }), { ok: false, reason: "MODULE_DISABLED" })
    const layout = read("src/app/(dashboard)/layout.tsx")
    for (const v of ["reservesNavVisible = isWorksiteReservesEnabled()", "salesDashboardNavVisible = isSalesDashboardEnabled()", "searchVisible = isGlobalSearchEnabled()"]) assert.ok(layout.includes(v), v)
  })
})
