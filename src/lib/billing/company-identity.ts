/**
 * Identité juridique de l'émetteur (devis, factures) : contrôle de complétude et pied de page.
 *
 * Mission du 29/10/2026 (point E) : les données indispensables manquantes sont SIGNALÉES dans les réglages
 * et avant émission ; elles ne sont jamais masquées par un pied de page générique ni inventées.
 * Références : economie.gouv.fr (DGCCRF, « Devis » et « Devis obligatoire ») — mentions attendues sur un
 * devis : identité et coordonnées du professionnel (nom, forme juridique, adresse, SIREN/SIRET, RCS/RM),
 * numéro de TVA intracommunautaire lorsque le professionnel y est assujetti.
 */

import type { BillingSettingsView } from "@/lib/billing/settings"
import { sirenFromSiret } from "@/lib/billing/settings"

export interface IssuerIdentityInput {
  name: string
  address: string | null
  siret: string | null
  email: string | null
  phone: string | null
  settings: Pick<BillingSettingsView, "legalForm" | "shareCapital" | "rcs" | "vatNumber">
}

export type IdentityStatus = "ok" | "missing" | "invalid" | "warning"

export interface IdentityCheck {
  key: "name" | "address" | "siret" | "legalForm" | "rcs" | "vatNumber" | "email"
  label: string
  status: IdentityStatus
  /** Explication courte affichée dans les réglages. */
  hint?: string
  /** Où corriger. */
  where: "entreprise" | "facturation"
}

export interface IssuerIdentityAssessment {
  checks: IdentityCheck[]
  /** Libellés des éléments indispensables manquants ou invalides (bloquants pour une émission sereine). */
  blocking: string[]
  /** Éléments à vérifier (non bloquants). */
  warnings: string[]
}

const digits = (v: string | null | undefined) => (v ?? "").replace(/\s/g, "")

/** Format plausible d'un numéro de TVA intracommunautaire (UE) : 2 lettres pays + 2 à 13 alphanumériques. Jamais un SIRET nu. */
export function isPlausibleVatNumber(value: string | null | undefined): boolean {
  const v = (value ?? "").replace(/\s/g, "").toUpperCase()
  if (!/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(v)) return false
  if (v.startsWith("FR")) return /^FR[A-Z0-9]{2}\d{9}$/.test(v)
  return true
}

/** Pour un numéro FR : les 9 derniers chiffres doivent être le SIREN de l'entreprise (quand il est connu). */
export function vatMatchesSiren(vatNumber: string | null | undefined, siret: string | null | undefined): boolean | null {
  const v = (vatNumber ?? "").replace(/\s/g, "").toUpperCase()
  const siren = sirenFromSiret(siret)
  if (!v.startsWith("FR") || !siren) return null
  return v.slice(-9) === siren
}

export function assessIssuerIdentity(input: IssuerIdentityInput): IssuerIdentityAssessment {
  const checks: IdentityCheck[] = []
  const name = input.name.trim()
  checks.push({ key: "name", label: "Dénomination", status: name ? "ok" : "missing", where: "entreprise" })
  checks.push({ key: "address", label: "Adresse du siège", status: input.address?.trim() ? "ok" : "missing", where: "entreprise" })

  const siret = digits(input.siret)
  checks.push(
    !siret
      ? { key: "siret", label: "SIRET", status: "missing", hint: "14 chiffres (SIREN + NIC)", where: "entreprise" }
      : /^\d{14}$/.test(siret)
        ? { key: "siret", label: "SIRET", status: "ok", where: "entreprise" }
        : /^\d{9}$/.test(siret)
          ? { key: "siret", label: "SIRET", status: "warning", hint: "seul le SIREN (9 chiffres) est renseigné : compléter avec le NIC de l'établissement", where: "entreprise" }
          : { key: "siret", label: "SIRET", status: "invalid", hint: "doit comporter 14 chiffres", where: "entreprise" }
  )
  checks.push({ key: "legalForm", label: "Forme juridique", status: input.settings.legalForm?.trim() ? "ok" : "missing", hint: "SAS, SARL, EI, EURL… (et capital social pour les sociétés)", where: "facturation" })
  checks.push({ key: "rcs", label: "Immatriculation (RCS / RM)", status: input.settings.rcs?.trim() ? "ok" : "missing", hint: "ex. « RCS Bobigny 992 885 251 » ; artisans : RM", where: "facturation" })

  const vat = input.settings.vatNumber?.trim() ?? ""
  if (!vat) {
    checks.push({ key: "vatNumber", label: "TVA intracommunautaire", status: "warning", hint: "absente : à renseigner si l'entreprise est assujettie ; sinon la mention de franchise (art. 293 B) doit figurer sur les documents", where: "facturation" })
  } else if (!isPlausibleVatNumber(vat)) {
    checks.push({ key: "vatNumber", label: "TVA intracommunautaire", status: "invalid", hint: "format attendu : FR + 2 caractères + 9 chiffres du SIREN", where: "facturation" })
  } else if (vatMatchesSiren(vat, input.siret) === false) {
    checks.push({ key: "vatNumber", label: "TVA intracommunautaire", status: "invalid", hint: "les 9 derniers chiffres ne correspondent pas au SIREN", where: "facturation" })
  } else {
    checks.push({ key: "vatNumber", label: "TVA intracommunautaire", status: "ok", where: "facturation" })
  }
  checks.push({ key: "email", label: "E-mail de contact", status: input.email?.trim() ? "ok" : "warning", hint: "recommandé sur les devis", where: "entreprise" })

  const blocking = checks.filter((c) => c.status === "missing" || c.status === "invalid").map((c) => c.label)
  const warnings = checks.filter((c) => c.status === "warning").map((c) => c.label)
  return { checks, blocking, warnings }
}

/** Pied de page : identité juridique exacte, uniquement à partir des données présentes (aucun texte générique). */
export function issuerLegalFooter(input: IssuerIdentityInput): string | null {
  const siret = digits(input.siret)
  const siren = sirenFromSiret(input.siret)
  const parts: (string | null)[] = [
    input.name.trim() || null,
    [input.settings.legalForm?.trim() || null, input.settings.shareCapital?.trim() ? `au capital de ${input.settings.shareCapital.trim()}` : null].filter(Boolean).join(" ") || null,
    input.address?.trim() || null,
    /^\d{14}$/.test(siret) ? `SIRET ${siret}` : siren ? `SIREN ${siren}` : null,
    input.settings.rcs?.trim() || null,
    input.settings.vatNumber?.trim() && isPlausibleVatNumber(input.settings.vatNumber) ? `TVA ${input.settings.vatNumber.replace(/\s/g, "").toUpperCase()}` : null,
  ]
  const kept = parts.filter((p): p is string => !!p)
  return kept.length > 0 ? kept.join(" — ") : null
}
