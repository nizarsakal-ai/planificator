/**
 * Sources de consultations (registre partenaires) — helpers purs pour l'écran
 * Paramètres. Aucune I/O ici : testable sans base.
 */

import type { PartnerAdminErrorCode } from "@/lib/acquisition/admin/partner-admin.errors"

/** Code stable dérivé du nom (« ATS Structures » → « ats-structures »). */
export function partnerCodeFromName(name: string, fallbackDomain = ""): string {
  const slug = (raw: string) =>
    raw
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "")
  return slug(name) || slug(fallbackDomain.split(".")[0] ?? "") || "partenaire"
}

/**
 * Accepte un domaine ou une adresse collée par l'utilisateur
 * (« eloux@ats67.com », « https://www.ats67.com/ ») et en extrait le domaine.
 * La validation stricte reste celle du service (domainInputSchema).
 */
export function extractDomainInput(raw: string): string {
  let value = raw.trim().toLowerCase()
  const at = value.lastIndexOf("@")
  if (at >= 0) value = value.slice(at + 1)
  value = value.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")
  return value
}

const ERROR_MESSAGES: Partial<Record<PartnerAdminErrorCode, string>> = {
  DOMAIN_ALREADY_EXISTS: "Ce domaine est déjà enregistré.",
  INVALID_DOMAIN: "Domaine invalide (exemple attendu : ats67.com).",
  INVALID_PARTNER_NAME: "Nom invalide.",
  INVALID_PARTNER_CODE: "Nom invalide.",
  PARTNER_NOT_FOUND: "Partenaire introuvable.",
  DOMAIN_NOT_FOUND: "Domaine introuvable.",
}

export function partnerAdminErrorMessage(code: PartnerAdminErrorCode | undefined): string {
  return (code && ERROR_MESSAGES[code]) ?? "Enregistrement impossible. Réessayez."
}

export type PartnerSourceView = {
  id: string
  name: string
  active: boolean
  domains: Array<{ id: string; domain: string; active: boolean }>
}
