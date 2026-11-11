/**
 * Lot B Planificator V2 : contrôles statiques de la migration et du schéma (purement additive, clés composites
 * d'entreprise, contraintes CHECK), et intégration désactivée par défaut.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const sql = readFileSync("prisma/migrations/20261110130000_v2_lot_b_equipment_rental/migration.sql", "utf8")
const schema = readFileSync("prisma/schema.prisma", "utf8")
const NEW_TABLES = ["equipment", "equipment_bookings", "equipment_rental_contracts", "equipment_maintenances"]

describe("migration du lot B", () => {
  it("purement additive : aucune suppression, aucune écriture de données, aucun ALTER d'une table existante", () => {
    assert.doesNotMatch(sql, /\bDROP\b/i)
    assert.doesNotMatch(sql, /\bUPDATE\b(?! CASCADE)|\bDELETE\b(?! RESTRICT)|\bTRUNCATE\b|\bINSERT\b/i)
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), `ALTER sur une table existante : ${m[1]}`)
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([a-z_]+)"/g)) assert.ok(NEW_TABLES.includes(m[1]), `index sur une table existante : ${m[1]}`)
    assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?(?:TRIGGER|FUNCTION|EXTENSION)/i)
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
  })
  it("chaque table porte companyId ; numéros uniques par entreprise", () => {
    for (const t of NEW_TABLES) {
      const body = sql.split(`CREATE TABLE "${t}" (`)[1].split(");")[0]
      assert.match(body, /"companyId" TEXT NOT NULL/, t)
    }
    assert.match(sql, /CREATE UNIQUE INDEX "equipment_companyId_number_key" ON "equipment"\("companyId", "number"\);/)
    assert.match(sql, /CREATE UNIQUE INDEX "equipment_rental_contracts_companyId_number_key" ON "equipment_rental_contracts"\("companyId", "number"\);/)
  })
  it("clés étrangères composites d'entreprise (aucune référence possible à une autre entreprise), jamais en cascade de suppression", () => {
    for (const re of [
      /"equipment_companyId_warehouseId_fkey" FOREIGN KEY \("companyId", "warehouseId"\) REFERENCES "warehouses"\("companyId", "id"\)/,
      /"equipment_bookings_companyId_equipmentId_fkey" FOREIGN KEY \("companyId", "equipmentId"\) REFERENCES "equipment"\("companyId", "id"\)/,
      /"equipment_bookings_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\)/,
      /"equipment_bookings_responsibleEmployeeId_companyId_fkey" FOREIGN KEY \("responsibleEmployeeId", "companyId"\) REFERENCES "employees"\("id", "companyId"\)/,
      /"equipment_rental_contracts_companyId_supplierId_fkey" FOREIGN KEY \("companyId", "supplierId"\) REFERENCES "suppliers"\("companyId", "id"\)/,
      /"equipment_rental_contracts_worksiteId_companyId_fkey" FOREIGN KEY \("worksiteId", "companyId"\) REFERENCES "worksites"\("id", "companyId"\)/,
      /"equipment_rental_contracts_companyId_supplierInvoiceId_fkey" FOREIGN KEY \("companyId", "supplierInvoiceId"\) REFERENCES "supplier_invoices"\("companyId", "id"\)/,
      /"equipment_maintenances_companyId_equipmentId_fkey" FOREIGN KEY \("companyId", "equipmentId"\) REFERENCES "equipment"\("companyId", "id"\)/,
    ]) assert.match(sql, re)
    assert.doesNotMatch(sql, /ON DELETE CASCADE/)
    assert.doesNotMatch(sql, /REFERENCES "(?:warehouses|equipment|worksites|employees|suppliers|supplier_invoices)"\("id"\)/, "aucune clé simple vers une table d'entreprise")
  })
  it("contraintes CHECK : période non vide, état cohérent avec le statut, coût figé seulement à la clôture", () => {
    assert.match(sql, /"equipment_values_check" CHECK \(/)
    assert.match(sql, /"equipment_bookings_values_check" CHECK \(\s*"endAt" > "startAt"/)
    assert.match(sql, /"status" = 'RETURNED' AND "checkedOutAt" IS NOT NULL AND "checkoutCondition" IS NOT NULL\s+AND "returnedAt" IS NOT NULL AND "returnCondition" IS NOT NULL AND "returnedAt" >= "checkedOutAt"/)
    assert.match(sql, /"equipment_rental_contracts_values_check" CHECK \(\s*"endDate" >= "startDate"/)
    assert.match(sql, /"status" = 'ACTIVE' AND "returnedOn" IS NULL AND "costCents" IS NULL/)
    assert.match(sql, /"equipment_maintenances_values_check" CHECK \(/)
  })
  it("schéma : modèles déclarés, coût de contrat en BigInt, relations des nouveaux modèles sans cascade", () => {
    for (const m of ["Equipment", "EquipmentBooking", "EquipmentRentalContract", "EquipmentMaintenance"]) assert.match(schema, new RegExp(`^model ${m} \\{`, "m"), m)
    assert.match(schema, /costCents\s+BigInt\?/)
    const lotB = schema.split("// Lot B Planificator V2 (04/11/2026)")[1]
    assert.ok(lotB)
    assert.doesNotMatch(lotB, /onDelete: Cascade/)
  })
})

describe("intégration désactivée par défaut et garde", () => {
  it("pages et actions passent par la garde du module ; aucun identifiant d'entreprise lu du client", () => {
    for (const f of ["src/app/(dashboard)/materiel/page.tsx", "src/app/(dashboard)/materiel/[id]/page.tsx", "src/app/(dashboard)/materiel/locations/page.tsx"]) {
      // v5 (preuves VM B r4, React #310) : refus rendu sur place, PREMIÈRE instruction de la page, avant toute lecture métier.
      const src = readFileSync(f, "utf8")
      const body = src.slice(src.indexOf("export default async function"))
      assert.match(body, /^export default async function \w+\([^\n]*\) \{\n  const ctx = await equipmentPageAccess\(\)\n  \/\/ [^\n]*\n  if \(!ctx\) return <AdminOnlyNotice \/>\n/, f)
      assert.doesNotMatch(src, /requireEquipmentPage|redirect\(/, `${f} : aucune redirection dans la page`)
    }
    assert.doesNotMatch(readFileSync("src/lib/equipment/access.ts", "utf8"), /redirect\("\/dashboard"\)/, "plus aucune redirection vers /dashboard dans la garde")
    const actions = readFileSync("src/lib/actions/equipment.actions.ts", "utf8")
    assert.match(actions, /^"use server"/)
    assert.match(actions, /const ctx = await requireEquipmentAdmin\(\)/)
    // Revue indépendante (bloquant levé) : le contrôle porte sur le CODE, commentaires retirés ; l'en-tête peut
    // expliquer que le companyId vient de la session.
    const code = actions.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
    assert.doesNotMatch(code, /companyId/)
    const svc = readFileSync("src/lib/equipment/equipment.service.ts", "utf8")
    const lock = /\$queryRaw[^`]*`([^`]*)`/.exec(svc)?.[1] ?? ""
    assert.match(lock, /FOR UPDATE/, "verrou de ligne")
    assert.match(lock, /"companyId" = \$\{ctx\.companyId\}/, "verrou borné à l'entreprise")
  })
  it("drapeau absent ⇒ 404 : la garde des pages appelle notFound() pour MODULE_DISABLED", () => {
    const access = readFileSync("src/lib/equipment/access.ts", "utf8")
    // v6 (preuve VM r5.2, 03 56/57) : depuis v5 la garde passe par la décision commune du lot A (pageDecision). Contrôle de la
    // chaîne réelle, sans ordre relâché : accès résolu, puis 404, puis connexion, puis refus rendu sur place (null).
    const garde = /export async function equipmentPageAccess\(\): Promise<EquipmentContext \| null> \{\n([\s\S]*?)\n\}/.exec(access)?.[1] ?? ""
    assert.match(access, /import \{[^}]*\bpageDecision\b[^}]*\} from "@\/lib\/stock\/access"/, "décision commune du lot A")
    assert.match(garde, /^ {2}const r = await resolveEquipmentAccess\(\)\n {2}if \(r\.ok\) return r\.context\n {2}const decision = pageDecision\(r\.reason\)\n {2}if \(decision === "NOT_FOUND"\) notFound\(\)\n {2}if \(decision === "LOGIN"\) redirect\("\/login"\)\n {2}return null$/, "garde : accès, 404, connexion, refus sur place")
    // Correspondance raison → décision (exécutée par tests/stock/access.test.ts et tests/equipment/access.test.ts).
    const stock = readFileSync("src/lib/stock/access.ts", "utf8")
    assert.match(stock, /if \(reason === "MODULE_DISABLED"\) return "NOT_FOUND"/, "module désactivé ⇒ 404")
    assert.match(stock, /if \(reason === "UNAUTHENTICATED"\) return "LOGIN"/, "non connecté ⇒ /login")
    assert.match(access, /if \(!isEquipmentRentalEnabled\(\)\) return \{ ok: false, reason: "MODULE_DISABLED" \}/, "drapeau contrôlé avant la session")
  })
  it("le layout n'affiche le menu qu'avec le drapeau et un rôle ADMIN/SUPER_ADMIN", () => {
    const layout = readFileSync("src/app/(dashboard)/layout.tsx", "utf8")
    assert.match(layout, /const equipmentNavVisible = isEquipmentRentalEnabled\(\) && \(role === "ADMIN" \|\| role === "SUPER_ADMIN"\) && !!companyId/)
  })
})
