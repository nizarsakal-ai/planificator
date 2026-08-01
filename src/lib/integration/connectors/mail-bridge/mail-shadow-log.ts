/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Logs structurés shadow — toujours redacted.
 */

import {
  redactError,
  redactLogFields,
} from "@/lib/integration/observability/redaction/redact"

export type MailShadowLogFields = {
  companyId?: string
  connectionId?: string
  connectorType?: string
  outcome?: string
  errorCode?: string
  durationMs?: number
  envelopeId?: string
  [key: string]: unknown
}

export function logMailShadow(
  level: "info" | "warn" | "error",
  message: string,
  fields: MailShadowLogFields = {}
): void {
  const payload = {
    scope: "integration.mail_shadow",
    message,
    ...redactLogFields(fields as Record<string, unknown>),
  }
  const line = JSON.stringify(payload)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.info(line)
}

export function logMailShadowError(
  message: string,
  fields: MailShadowLogFields,
  error: unknown
): void {
  const redacted = redactError(error)
  logMailShadow("error", message, {
    ...fields,
    errorCode: fields.errorCode ?? "shadow_error",
    errorName: redacted.name,
    errorMessage: redacted.message,
  })
}
