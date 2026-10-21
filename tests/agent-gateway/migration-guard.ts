/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A — garde-fou de périmètre de la migration agent_gateway_foundation.
 * Code de TEST uniquement (aucune dépendance applicative).
 *
 * Principe (revue Codex 2026-10-21) : LISTE FERMÉE des formes d'instructions admises ; toute
 * instruction non reconnue, ou reconnue mais hors cible, est une violation. Ce n'est pas un
 * analyseur SQL général : il n'admet que les formes exactes produites par `prisma migrate` pour
 * les objets de ce lot, et rejette tout le reste.
 */

export const AGENT_TABLES = [
  "agent_principals",
  "agent_access_logs",
  "agent_rate_windows",
  "agent_anon_rate_windows",
  "agent_gateway_control",
] as const

export const AGENT_TYPES = ["AgentPrincipalStatus", "AgentAccessOutcome", "AgentScope"] as const

/** Seules tables existantes qu'une FK du lot a le droit de référencer. */
export const ALLOWED_FK_TARGETS = ["companies", "users"] as const

export type MigrationStatementKind = "create_type" | "create_table" | "create_index" | "add_foreign_key"

export interface AcceptedStatement {
  readonly kind: MigrationStatementKind
  readonly target: string
  readonly sql: string
}

export interface MigrationViolation {
  readonly index: number
  readonly reason: string
  readonly excerpt: string
}

export interface MigrationGuardResult {
  readonly accepted: ReadonlyArray<AcceptedStatement>
  readonly violations: ReadonlyArray<MigrationViolation>
}

const IDENT = '"([A-Za-z_][A-Za-z0-9_]*)"'
const COL_LIST = `\\(\\s*${IDENT}(?:\\s*,\\s*${IDENT})*\\s*\\)`

const RE_CREATE_TYPE = new RegExp(`^CREATE TYPE ${IDENT} AS ENUM \\((\\s*'[A-Z_]+'(?:\\s*,\\s*'[A-Z_]+')*\\s*)\\)$`)
const RE_CREATE_TABLE = new RegExp(`^CREATE TABLE ${IDENT} \\(([\\s\\S]*)\\)$`)
const RE_CREATE_INDEX = new RegExp(`^CREATE (UNIQUE )?INDEX ${IDENT} ON ${IDENT}${COL_LIST}$`)
const RE_ADD_FK = new RegExp(
  `^ALTER TABLE ${IDENT} ADD CONSTRAINT ${IDENT} FOREIGN KEY \\(${IDENT}\\) REFERENCES ${IDENT}\\(${IDENT}\\) ` +
    `ON DELETE (RESTRICT|SET NULL|CASCADE) ON UPDATE CASCADE$`
)

/** Ligne de colonne admise dans un CREATE TABLE du lot (type scalaire ou enum du lot, contraintes simples). */
const RE_COLUMN_LINE = new RegExp(
  `^${IDENT} (TEXT|INTEGER|BOOLEAN|TIMESTAMP\\(3\\)|"(?:${AGENT_TYPES.join("|")})"(?:\\[\\])?)` +
    `(?: NOT NULL)?(?: DEFAULT (?:'[A-Z_]+'|CURRENT_TIMESTAMP|true|false|-?\\d+))?$`
)
const RE_PK_LINE = new RegExp(`^CONSTRAINT ${IDENT} PRIMARY KEY ${COL_LIST}$`)

const isAgentTable = (t: string): boolean => (AGENT_TABLES as ReadonlyArray<string>).includes(t)
const isAgentType = (t: string): boolean => (AGENT_TYPES as ReadonlyArray<string>).includes(t)

/** Supprime les commentaires `--` puis découpe sur `;`. Aucune chaîne du lot ne contient `;` ni `--`. */
export function splitStatements(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, "")
  return noComments
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
}

function checkCreateTableBody(table: string, body: string): string | null {
  const lines = body
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  // Les listes de colonnes d'une PK composite contiennent des virgules : on recolle les fragments.
  const merged: string[] = []
  for (const l of lines) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && /PRIMARY KEY \([^)]*$/.test(prev)) merged[merged.length - 1] = `${prev},${l}`
    else merged.push(l)
  }
  let pk = 0
  for (const line of merged) {
    if (RE_PK_LINE.test(line)) {
      pk++
      continue
    }
    if (!RE_COLUMN_LINE.test(line)) return `définition de colonne non admise dans ${table} : ${line}`
  }
  if (pk !== 1) return `${table} doit déclarer exactement une clé primaire (trouvé ${pk})`
  return null
}

/**
 * Classe chaque instruction. Retourne les instructions acceptées et les violations.
 * Une migration est conforme ssi `violations.length === 0`.
 */
export function validateMigration(sql: string): MigrationGuardResult {
  const accepted: AcceptedStatement[] = []
  const violations: MigrationViolation[] = []
  const statements = splitStatements(sql)

  statements.forEach((stmt, index) => {
    const reject = (reason: string): void => {
      violations.push({ index, reason, excerpt: stmt.slice(0, 80) })
    }

    let m: RegExpMatchArray | null

    if ((m = stmt.match(RE_CREATE_TYPE))) {
      const [, name] = m
      if (!isAgentType(name)) return reject(`type hors périmètre : ${name}`)
      return void accepted.push({ kind: "create_type", target: name, sql: stmt })
    }

    if ((m = stmt.match(RE_CREATE_TABLE))) {
      const [, table, body] = m
      if (!isAgentTable(table)) return reject(`table hors périmètre : ${table}`)
      if (/REFERENCES|CHECK|UNIQUE|GENERATED|TRIGGER/i.test(body)) return reject(`clause non admise dans CREATE TABLE ${table}`)
      const bodyError = checkCreateTableBody(table, body)
      if (bodyError) return reject(bodyError)
      return void accepted.push({ kind: "create_table", target: table, sql: stmt })
    }

    if ((m = stmt.match(RE_CREATE_INDEX))) {
      const [, , , table] = m
      if (!isAgentTable(table)) return reject(`index hors périmètre : ${table}`)
      return void accepted.push({ kind: "create_index", target: table, sql: stmt })
    }

    if ((m = stmt.match(RE_ADD_FK))) {
      const [, table, , , refTable, refCol] = m
      if (!isAgentTable(table)) return reject(`ALTER TABLE hors périmètre : ${table}`)
      const refAllowed = isAgentTable(refTable) || (ALLOWED_FK_TARGETS as ReadonlyArray<string>).includes(refTable)
      if (!refAllowed) return reject(`cible de FK non admise : ${refTable}`)
      if (refCol !== "id") return reject(`colonne référencée non admise : ${refTable}.${refCol}`)
      return void accepted.push({ kind: "add_foreign_key", target: table, sql: stmt })
    }

    return reject("instruction non reconnue (hors liste fermée)")
  })

  return { accepted, violations }
}
