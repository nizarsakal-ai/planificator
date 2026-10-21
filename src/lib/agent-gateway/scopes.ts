/**
 * PLAN-AGENT-GATEWAY-001 — LOT-1A
 * Correspondance unique entre l'enum Prisma `AgentScope` (stockage) et les scopes
 * du contrat (chaînes `ressource:read`, SPEC §6.1). Source de vérité pour Zod et OpenAPI.
 *
 * Invariants (testés) :
 *  - bijection enum ↔ chaîne ;
 *  - exhaustivité : chaque membre de l'enum a une entrée (garanti à la compilation
 *    par `satisfies Record<AgentScope, …>` et à l'exécution par le test) ;
 *  - aucun scope d'écriture n'existe en v1 ;
 *  - `fromContractScope` rejette toute chaîne hors table (jamais de passage silencieux).
 */

import { AgentScope } from "@prisma/client"

export const AGENT_SCOPE_TO_CONTRACT = {
  WORKSITES_READ: "worksites:read",
  EMPLOYEES_READ: "employees:read",
  ASSIGNMENTS_READ: "assignments:read",
  ABSENCES_READ: "absences:read",
} as const satisfies Record<AgentScope, `${string}:read`>

export type ContractScope = (typeof AGENT_SCOPE_TO_CONTRACT)[AgentScope]

/** Liste fermée des chaînes du contrat, dans l'ordre de l'enum. */
export const CONTRACT_SCOPES: readonly ContractScope[] = Object.values(AgentScope).map(
  (scope) => AGENT_SCOPE_TO_CONTRACT[scope]
)

const CONTRACT_TO_AGENT_SCOPE: ReadonlyMap<string, AgentScope> = new Map(
  (Object.keys(AGENT_SCOPE_TO_CONTRACT) as AgentScope[]).map((scope) => [
    AGENT_SCOPE_TO_CONTRACT[scope],
    scope,
  ])
)

export class UnknownContractScopeError extends Error {
  readonly code = "AGENT_SCOPE_UNKNOWN" as const
  constructor(readonly received: string) {
    super(`Scope de contrat inconnu : "${received}"`)
    this.name = "UnknownContractScopeError"
  }
}

export function toContractScope(scope: AgentScope): ContractScope {
  return AGENT_SCOPE_TO_CONTRACT[scope]
}

/** Strict : casse exacte, aucune normalisation. */
export function fromContractScope(value: string): AgentScope {
  const scope = CONTRACT_TO_AGENT_SCOPE.get(value)
  if (scope === undefined) throw new UnknownContractScopeError(value)
  return scope
}

export function isContractScope(value: unknown): value is ContractScope {
  return typeof value === "string" && CONTRACT_TO_AGENT_SCOPE.has(value)
}

export function toContractScopes(scopes: readonly AgentScope[]): ContractScope[] {
  return scopes.map(toContractScope)
}
