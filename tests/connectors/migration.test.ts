/**
 * Lot F Planificator V2 : contrôles statiques (migration additive, aucun objet existant modifié, aucun mode réel,
 * CHECK et déclencheurs), gardes des pages et actions, menus conditionnés.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { describe, it } from "node:test"

const MIGRATION_DIR = "20261119120000_v2_lot_f_connectors_assistant"
const sql = readFileSync(`prisma/migrations/${MIGRATION_DIR}/migration.sql`, "utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const MARKER = "// Lot F Planificator V2 (04/11/2026, porté sur ab987847 le 19/11/2026)"
const NEW_TABLES = ["connector_settings", "connector_sync_runs", "connector_staged_records", "assistant_proposals", "assistant_action_logs"]
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
const read = (f: string) => readFileSync(f, "utf8")

describe("migration du lot F", () => {
  it("SQL figé (v6 + trois listes connectorKey étendues en v4) ; seule migration nouvelle, horodatée après toutes celles de la base", () => {
    // v4 : seules les trois listes fermées `connectorKey` changent (dix connecteurs) ; toutes les autres lignes de la v6
    // (258e9bcf…) sont conservées. À requalifier dans une base jetable neuve.
    assert.equal(createHash("sha256").update(readFileSync(`prisma/migrations/${MIGRATION_DIR}/migration.sql`)).digest("hex"), "9c34d988366c77dadef8732346555a76bb452c3f1a472b328260c6cf709a2e9b")
    const dirs = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()
    // Intégration FGHI : F reste après toutes les migrations de la base ; seules les migrations G, H et I la suivent.
    assert.ok(MIGRATION_DIR > "20261117120000_vehicle_tour_auto_km", "après la dernière migration de main 90ae644")
    // Seuls les lots G, H, I suivent F ; les migrations ultérieures hors lots (photos, espace PDF du Studio…) ne comptent pas.
    assert.deepEqual(dirs.filter((d) => d > MIGRATION_DIR && /_v2_lot_/.test(d)), ["20261119130000_v2_lot_g_document_studio", "20261119140000_v2_lot_h_payroll_prep", "20261119150000_v2_lot_i_marketing_shop"], "seules G, H, I après F")
    assert.equal(dirs.filter((d) => /lot_f/.test(d)).length, 1, "une seule migration du lot F")
    // Le lot D (réserves et réception) a été intégré depuis (commit « Intègre le lot D et le correctif DG02 ») : sa migration
    // unique existe et précède F ; l'invariant de F reste qu'elle ne crée aucun objet du lot D (assertion suivante).
    assert.deepEqual(dirs.filter((d) => /lot_d|reserve/.test(d)), ["20261112120000_v2_lot_d_reserves_reception"], "une seule migration du lot D")
    assert.ok(dirs.filter((d) => /lot_d/.test(d)).every((d) => d < MIGRATION_DIR), "lot D avant F")
    assert.doesNotMatch(sql, /worksite_reserves|reception_report/, "aucun objet du lot D")
  })
  it("additive : aucun objet existant modifié (ni table, ni type), aucune donnée lue ni écrite", () => {
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
    assert.doesNotMatch(sql, /integration_connections|integration_inbound_envelopes|agent_principals/, "plateforme existante intacte")
  })
  it("lot F d'origine : l'énumération créée n'a que DISABLED et SIMULATION ; journal en simulation seulement", () => {
    assert.match(sql, /CREATE TYPE "ConnectorMode" AS ENUM \('DISABLED', 'SIMULATION'\);/)
    // LOT-8B : LIVE ajouté par une migration dédiée (voir le bloc « connexion réelle » ci-dessous).
    assert.match(schema, /enum ConnectorMode \{\n  DISABLED\n  SIMULATION\n(?:  \/\/\/[^\n]*\n)?  LIVE\n\}/)
    assert.match(sql, /"mode" = 'SIMULATION'\n  AND "connectorKey" IN/)
    assert.match(sql, /connector is not in simulation mode/)
    assert.ok(schema.includes(MARKER), "marqueur du lot F présent")
    assert.doesNotMatch(schema.split(MARKER)[1], /credential|secret|token|apiKey|password/i, "aucune colonne d'identifiant")
  })
  it("clés composites d'entreprise, aucune cascade ; idempotence par identifiant externe ; une proposition par source", () => {
    for (const re of [
      /"connector_sync_runs_companyId_settingId_fkey" FOREIGN KEY \("companyId", "settingId"\) REFERENCES "connector_settings"\("companyId", "id"\) ON DELETE RESTRICT/,
      /"assistant_action_logs_companyId_proposalId_fkey" FOREIGN KEY \("companyId", "proposalId"\) REFERENCES "assistant_proposals"\("companyId", "id"\) ON DELETE RESTRICT/,
      /CREATE UNIQUE INDEX "connector_staged_records_companyId_connectorKey_resource_ex_key" ON "connector_staged_records"\("companyId", "connectorKey", "resource", "externalId"\);/,
      /CREATE UNIQUE INDEX "assistant_proposals_companyId_sourceKey_key" ON "assistant_proposals"\("companyId", "sourceKey"\);/,
      /CREATE UNIQUE INDEX "connector_settings_companyId_connectorKey_key" ON "connector_settings"\("companyId", "connectorKey"\);/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    // Section du lot F seulement (jusqu'au bandeau du lot G) : les modèles ajoutés après, hors connecteurs, ont leurs propres règles.
    const lotF = schema.split(MARKER)[1].split("// Lot G Planificator V2")[0]
    assert.ok(lotF.includes("model ") && lotF.length < schema.split(MARKER)[1].length, "section du lot F bornée")
    assert.doesNotMatch(lotF, /onDelete: Cascade/)
  })
  it("CHECK et déclencheurs : décisions définitives, résultat = tâche de la même entreprise, journaux immuables", () => {
    assert.match(sql, /\("status" = 'EXECUTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "resultEntityType" IS NOT NULL AND "resultEntityType" = 'Task' AND "resultEntityId" IS NOT NULL\)/)
    assert.match(sql, /\("status" = 'FAILED' AND "errorCode" IS NOT NULL AND "errorCode" IN \(/, "IS NOT NULL explicite : un code NULL ne passe pas le CHECK")
    assert.match(sql, /assistant proposal must start pending/)
    assert.match(sql, /assistant proposal already decided/)
    assert.match(sql, /assistant proposal content immutable/)
    assert.match(sql, /assistant proposal result must be a task of the same company/)
    assert.match(sql, /staged record update must be a new version of a changed payload/)
    assert.match(sql, /"received" = "created" \+ "updated" \+ "unchanged"/)
    assert.match(sql, /"rule" IN \('OPPORTUNITY_FOLLOW_UP_OVERDUE', 'RESERVE_OVERDUE', 'STOCK_BELOW_MINIMUM'\)/, "règles en liste fermée")
    assert.match(sql, /"errorCode" IN \('SOURCE_UNAVAILABLE', 'SOURCE_ITEM_INVALID', 'WATERMARK_INVALID', 'REAL_CONNECTION_DISABLED', 'INTERNAL_ERROR'\)/, "codes d'erreur en liste fermée")
    for (const t of ["connector_sync_runs", "assistant_action_logs"]) assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON "${t}"\\s+FOR EACH ROW EXECUTE FUNCTION lot_f_history_immutable\\(\\)`), t)
    for (const t of NEW_TABLES) assert.match(sql, new RegExp(`BEFORE TRUNCATE ON "${t}"`), t)
  })
})

describe("gardes et menus", () => {
  it("pages et actions passent par leur garde ; refus rendu sur place (aucune redirection vers /dashboard) ; aucun companyId lu du client", () => {
    for (const [f, g] of [["src/app/(dashboard)/connecteurs/page.tsx", "connectorPageAccess"], ["src/app/(dashboard)/assistant/page.tsx", "assistantPageAccess"]]) {
      const p = read(f)
      assert.match(p, new RegExp(`const ctx = await ${g}\\(\\)\\n[^\\n]*\\n  if \\(!ctx\\) return <AdminOnlyNotice />`), f)
    }
    for (const f of ["src/lib/connectors/access.ts", "src/lib/assistant/access.ts"]) {
      const a = code(read(f))
      assert.match(a, /const decision = pageDecision\(r\.reason\)/, f)
      assert.doesNotMatch(a, /redirect\("\/dashboard"\)/, `${f} : pas de redirection en rendu en flux (React #310)`)
    }
    for (const [f, g] of [["src/lib/actions/connector.actions.ts", "requireConnectorAdmin"], ["src/lib/actions/assistant.actions.ts", "requireAssistantAdmin"]]) {
      const a = read(f)
      assert.match(a, /^"use server"/, f)
      assert.match(a, new RegExp(`await ${g}\\(\\)`), f)
      assert.doesNotMatch(code(a), /companyId:\s*(?:str|form|optId|reqId)/, f)
    }
    assert.match(read("src/lib/actions/assistant.actions.ts"), /if \(str\(form, "confirm", 5\) !== "oui"\) return \{ ok: false, error: "Cochez la confirmation d'approbation\." \}/, "approbation explicite")
  })
  it("verrous : réglage du connecteur et proposition verrouillés en exclusif, bornés par l'entreprise ; génération sérialisée", () => {
    const c = read("src/lib/connectors/connectors.service.ts")
    assert.match(c, /WHERE "companyId" = \$\{ctx\.companyId\} AND "connectorKey" = \$\{key\} FOR UPDATE/)
    const a = read("src/lib/assistant/assistant.service.ts")
    assert.match(a, /FROM "assistant_proposals" WHERE "id" = \$\{id\} AND "companyId" = \$\{ctx\.companyId\} FOR UPDATE/)
    assert.match(a, /pg_advisory_xact_lock\(hashtextextended\(\$\{`assistant:\$\{ctx\.companyId\}`\}, 0\)\)/)
  })
  it("layout : menus conditionnés par drapeau, rôle ADMIN/SUPER_ADMIN et société", () => {
    const layout = read("src/app/(dashboard)/layout.tsx")
    for (const v of [
      `const assistantNavVisible = isAssistantEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`,
      `const connectorsNavVisible = isConnectorCenterEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")`,
    ]) assert.ok(layout.includes(v), v)
    // Les drapeaux sont transmis au menu via l'objet `user` ; d'autres modules (lot D, tableau de bord commercial, recherche,
    // copilote) y ont été ajoutés après eux : on vérifie leur présence, pas leur position en fin d'objet.
    const userObject = /const user = \{([^}]*)\}/.exec(layout)?.[1] ?? ""
    const passed = userObject.split(",").map((s) => s.trim())
    for (const k of ["crmNavVisible", "automationNavVisible", "assistantNavVisible", "connectorsNavVisible"]) assert.ok(passed.includes(k), `user.${k}`)
  })
  it("assistant : sources CRM et stock seulement, chacune sous son drapeau ; aucune source du lot D", () => {
    const a = read("src/lib/actions/assistant.actions.ts")
    assert.ok(a.includes("const enabledSources = (): svc.EnabledSources => ({ crm: isCrmEnabled(), stock: isStockPurchasingEnabled() })"))
    // Même décision à la génération et à l'approbation (v2) : les deux actions transmettent les drapeaux réels.
    assert.ok(a.includes("svc.generateProposals(prisma, ctx, enabledSources())"), "génération")
    assert.match(a, /svc\.approveProposal\(prisma, ctx, [^\n]*, undefined, enabledSources\(\)\)/, "approbation")
    assert.doesNotMatch(code(a), /reserves/i)
  })
})
