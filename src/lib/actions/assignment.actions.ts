"use server"

import { checkTeamConflictCore } from "@/lib/actions/assignment-team-conflict.core"

/**
 * Ticket #77 : lecture bornée à l'entreprise de la session (équipe ET chantier),
 * refus sans `companyId`. Logique et tests dans `assignment-team-conflict.core.ts`.
 */
export async function checkTeamConflict(teamId: string, date: string, excludeWorksiteId?: string) {
  return checkTeamConflictCore(teamId, date, excludeWorksiteId)
}
