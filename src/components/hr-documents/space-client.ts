import { HR_DOWNLOAD_MESSAGES } from "@/lib/hr-documents/download-client"
import type { CategoryDefinition } from "@/lib/hr-documents/catalog"

/** Types et appel réseau partagés par l'espace privé RH ↔ salarié (aucune logique d'accès : tout est filtré côté serveur). */
export type SpaceMode = "hr" | "employee"
export type FolderDoc = { id: string; employeeId: string; title: string; period: string; category: string; status: string; version: number
  size: number; createdAt?: string; publishedAt?: string | null; openedAt?: string; fromEmployee?: boolean }
export type Category = Pick<CategoryDefinition, "code" | "label" | "family">

/**
 * Période technique (AAAA-MM) exigée par le serveur pour le classement et la détection de doublon, jamais saisie :
 * valeur proposée ou déjà enregistrée si valide, sinon le mois du dépôt. Remplace le champ `type="month"`,
 * rendu en texte libre par Safari et Firefox (« juin 2030 » envoyé tel quel → refus systématique du serveur).
 */
export function documentPeriod(proposed?: string | null): string {
  if (proposed && /^\d{4}-(0[1-9]|1[0-2])$/.test(proposed)) return proposed
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

/** Appel JSON : une page de connexion HTML ou une redirection n'est jamais lue comme une réponse valide. */
export async function callJson<T>(url: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<T> {
  let response: Response
  try { response = await fetchImpl(url, { ...init, cache: "no-store", credentials: "same-origin" }) } catch { throw new Error(HR_DOWNLOAD_MESSAGES.network) }
  if (response.redirected || response.type === "opaqueredirect" || !(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error(HR_DOWNLOAD_MESSAGES.session)
  const data = await response.json().catch(() => ({})) as { error?: unknown }
  if (!response.ok) throw new Error(typeof data.error === "string" && data.error ? data.error : "Opération indisponible.")
  return data as T
}
