// Une empreinte porte sur les événements réellement visibles dans l'instantané de déclaration,
// jamais sur leur horodatage de création (qui peut précéder leur commit).
import { createHash } from "node:crypto"
export type VatAllocationHistory = { version: 1; invoiceDigests: Record<string, string> }
export function allocationDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export function readAllocationHistory(details: unknown): VatAllocationHistory | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null
  const h = (details as Record<string, unknown>).allocationHistory
  if (!h || typeof h !== "object" || Array.isArray(h)) return null
  const obj = h as Record<string, unknown>
  if (obj.version !== 1 || !obj.invoiceDigests || typeof obj.invoiceDigests !== "object" || Array.isArray(obj.invoiceDigests)) return null
  if (!Object.values(obj.invoiceDigests).every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return null
  return h as VatAllocationHistory
}
