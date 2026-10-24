/**
 * Menu des actions clients — logique pure (sans React, sans Prisma), testable en isolation.
 *
 * `CLIENT_DELETE_ROLES` est la source unique des rôles autorisés à supprimer un client :
 * la garde serveur `requireDeleteAdmin` (client.actions.ts) et le calcul de `canDelete`
 * côté page la partagent. TEAM_LEADER peut créer, modifier et désactiver, pas supprimer.
 */

import type { Role } from "@prisma/client"

export const CLIENT_DELETE_ROLES: readonly Role[] = ["ADMIN", "SUPER_ADMIN"]

export type ClientMenuAction = "edit" | "deactivate" | "reactivate" | "delete"

/** Vrai pour ADMIN et SUPER_ADMIN ; faux pour TEAM_LEADER, EMPLOYEE, CLIENT. */
export function canDeleteClient(role: Role | null | undefined): boolean {
  return role != null && CLIENT_DELETE_ROLES.includes(role)
}

/** Entrées du menu « ⋯ », dans l'ordre d'affichage ; la suppression reste en dernier et n'apparaît que si autorisée. */
export function getClientMenuActions(active: boolean, canDelete: boolean): ClientMenuAction[] {
  const actions: ClientMenuAction[] = ["edit", active ? "deactivate" : "reactivate"]
  if (canDelete) actions.push("delete")
  return actions
}
