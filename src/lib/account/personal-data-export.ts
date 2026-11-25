/**
 * Lot 2b juridique : export « Mes données » (RGPD art. 15 accès et art. 20 portabilité), au format JSON.
 * Pur et testable : la route lit la base et passe ici les lignes déjà limitées au compte connecté.
 * Jamais exportés : mot de passe (même chiffré), jetons, clés, données d'autres personnes.
 */

export const EXPORT_ROW_LIMIT = 5000

type Row = Record<string, unknown>

export interface PersonalDataSource {
  user: { id: string; email: string; name: string | null; role: string; createdAt: Date; lastLoginAt: Date | null } & Row
  employees: (Row & { company?: { name: string } | null })[]
  timeclocks: Row[]
  absences: Row[]
  expenseReports: Row[]
  assignments: Row[]
  hrDocuments: Row[]
  notifications: Row[]
}

const FORBIDDEN_KEYS = /^(password|token|secret|apiKey|refreshToken|accessToken|uploadKey|sha256)$/i

/** Retire récursivement toute clé sensible, au cas où une requête en sélectionnerait une par erreur. */
export function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).filter(([k]) => !FORBIDDEN_KEYS.test(k)).map(([k, v]) => [k, stripSensitive(v)]),
    )
  }
  return value
}

export function buildPersonalDataExport(source: PersonalDataSource, now = new Date()) {
  return stripSensitive({
    application: "Planificator",
    exportedAt: now,
    notice:
      "Copie des données personnelles liées à votre compte (RGPD art. 15 et 20). Les documents RH sont listés ; leurs fichiers se téléchargent depuis « Mes documents ». Pour toute autre demande, consultez la politique de confidentialité.",
    compte: {
      id: source.user.id,
      email: source.user.email,
      nom: source.user.name,
      role: source.user.role,
      creeLe: source.user.createdAt,
      derniereConnexion: source.user.lastLoginAt,
    },
    fichesEmploye: source.employees,
    pointages: source.timeclocks,
    absences: source.absences,
    notesDeFrais: source.expenseReports,
    affectations: source.assignments,
    documentsRh: source.hrDocuments,
    notifications: source.notifications,
  }) as Row
}

export function exportFileName(now = new Date()): string {
  return `planificator-mes-donnees-${now.toISOString().slice(0, 10)}.json`
}
