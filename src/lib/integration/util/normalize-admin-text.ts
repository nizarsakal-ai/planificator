/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
 * Normalisation des textes admin (displayName, value brute) :
 * trim → NFC → non vide → Array.from → borne.
 * Couche util pure — ni Prisma, ni persistence.
 */

export class AdminTextNormalizationError extends Error {
  readonly code = "ADMIN_TEXT_INVALID" as const

  constructor(message: string) {
    super(message)
    this.name = "AdminTextNormalizationError"
  }
}

/**
 * @returns texte normalisé (NFC, trim), garanti non vide et ≤ max points de code.
 */
export function normalizeAdminText(
  raw: string,
  maxCodePoints: number,
  label: string
): string {
  if (typeof raw !== "string") {
    throw new AdminTextNormalizationError(`${label} requis`)
  }
  const normalized = raw.normalize("NFC").trim()
  if (normalized.length === 0) {
    throw new AdminTextNormalizationError(`${label} vide après normalisation`)
  }
  if (Array.from(normalized).length > maxCodePoints) {
    throw new AdminTextNormalizationError(
      `${label} dépasse ${maxCodePoints} points de code`
    )
  }
  return normalized
}
