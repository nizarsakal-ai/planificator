/**
 * Santé d'une boîte Gmail Acquisition, dérivée du curseur de scan (aucune donnée sensible).
 *
 * Objectif : ne plus afficher « active » pour une boîte dont la synchronisation échoue
 * en silence (jeton révoqué, scope Gmail non accordé, message bloquant…).
 */

export type MailboxHealthLevel = "ok" | "pending" | "warning" | "error" | "inactive"

export interface MailboxHealthCursor {
  lastSyncedAt: Date | string | null
  consecutiveFailures: number
  lastErrorCode: string | null
  lastErrorAt: Date | string | null
}

export interface MailboxHealth {
  level: MailboxHealthLevel
  /** Libellé court affiché à côté de l'adresse. */
  label: string
  /** Action ou explication pour l'utilisateur (optionnelle). */
  hint?: string
}

/** Au-delà, une boîte « saine » mais muette est signalée (cadence nominale : horaire). */
export const MAILBOX_STALE_AFTER_MS = 3 * 60 * 60 * 1000

function toDate(value: Date | string | null): Date | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `il y a ${hours} h`
  return `il y a ${Math.floor(hours / 24)} j`
}

export function assessAcquisitionMailboxHealth(input: {
  active: boolean
  cursor: MailboxHealthCursor | null
  /** Dernière (re)connexion OAuth de la boîte (AcquisitionGmailConnection.updatedAt). */
  connectionUpdatedAt?: Date | string | null
  now?: Date
}): MailboxHealth {
  const now = input.now ?? new Date()
  if (!input.active) return { level: "inactive", label: "inactive" }

  const cursor = input.cursor
  const lastSyncedAt = cursor ? toDate(cursor.lastSyncedAt) : null
  const failures = cursor?.consecutiveFailures ?? 0
  const lastErrorAt = cursor ? toDate(cursor.lastErrorAt) : null
  const reconnectedAt = toDate(input.connectionUpdatedAt ?? null)

  // Échecs antérieurs à une reconnexion : on attend le prochain run avant de juger.
  if (failures > 0 && reconnectedAt && lastErrorAt && reconnectedAt > lastErrorAt) {
    return {
      level: "pending",
      label: "reconnectée",
      hint: "Boîte reconnectée : vérification à la prochaine synchronisation (toutes les heures).",
    }
  }

  if (cursor && failures > 0) {
    const since = lastErrorAt
    const sinceLabel = since ? ` (${formatElapsed(now.getTime() - since.getTime())})` : ""

    if (cursor.lastErrorCode === "PROVIDER_LIST_FAILED") {
      if (failures >= 2) {
        return {
          level: "error",
          label: "reconnexion requise",
          hint:
            `Gmail refuse l'accès depuis ${failures} synchronisations${sinceLabel}. ` +
            "Cliquez sur « Connecter une boîte Gmail » avec ce compte et cochez bien l'accès en lecture à Gmail.",
        }
      }
      return {
        level: "warning",
        label: "échec de synchronisation",
        hint: `La dernière synchronisation a échoué${sinceLabel}. Nouvel essai automatique.`,
      }
    }

    if (cursor.lastErrorCode === "PROVIDER_RATE_LIMITED") {
      return {
        level: "warning",
        label: "limite Gmail atteinte",
        hint:
          `Gmail limite temporairement le nombre de lectures${sinceLabel}. ` +
          "Reprise automatique à la prochaine synchronisation, aucune action nécessaire.",
      }
    }

    if (cursor.lastErrorCode === "MESSAGE_INGESTION_FAILED") {
      return {
        level: "warning",
        label: "synchronisation ralentie",
        hint:
          `Un e-mail n'a pas pu être enregistré${sinceLabel}. ` +
          "Reprise automatique ; il sera ignoré s'il bloque encore après plusieurs essais.",
      }
    }

    // Cause non liée à l'accès Gmail : pas de bouton « Reconnecter » trompeur.
    return {
      level: "warning",
      label: "échec de synchronisation",
      hint: `${failures} échec(s) consécutif(s)${sinceLabel}. Nouvel essai automatique.`,
    }
  }

  if (!lastSyncedAt) {
    return { level: "pending", label: "en attente de synchronisation" }
  }

  const elapsed = now.getTime() - lastSyncedAt.getTime()
  if (elapsed > MAILBOX_STALE_AFTER_MS) {
    return {
      level: "warning",
      label: `synchronisée ${formatElapsed(elapsed)}`,
      hint: "Aucune synchronisation récente : vérifiez que la tâche planifiée Acquisition tourne.",
    }
  }

  return { level: "ok", label: `synchronisée ${formatElapsed(elapsed)}` }
}

/** Messages d'erreur du callback OAuth (paramètre `reason`). */
export function acquisitionGmailOAuthErrorMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "missing_gmail_scope":
      return "Accès Gmail non accordé : sur l'écran Google, cochez « Lire vos e-mails Gmail » puis validez. Aucune modification n'a été enregistrée."
    case "access_denied":
      return "Connexion annulée sur l'écran Google."
    case "no_tokens":
      return "Google n'a pas renvoyé de jeton durable. Réessayez la connexion."
    case "tenant_mismatch":
    case "invalid_state":
      return "Session de connexion invalide ou expirée. Réessayez depuis cette page."
    default:
      return "Échec de la connexion Gmail Acquisition."
  }
}

/** Adresse proposée à Google (login_hint) — format borné, jamais réfléchie ailleurs. */
const LOGIN_HINT_RE = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/

export function parseLoginHint(raw: string | null | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? ""
  return LOGIN_HINT_RE.test(value) ? value : null
}

/** URL du bouton « Reconnecter » d'une boîte. */
export function acquisitionGmailReconnectUrl(gmailAddress: string): string {
  return `/api/acquisition/gmail/connect?hint=${encodeURIComponent(gmailAddress)}`
}

/** Une boîte qui demande une action humaine (affichage bouton / bandeau). */
export function mailboxNeedsReconnect(health: MailboxHealth): boolean {
  return health.level === "error"
}
