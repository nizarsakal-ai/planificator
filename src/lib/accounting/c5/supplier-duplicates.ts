// Doublons de factures fournisseurs (retour 18/11/2026, CALI GAME n° 36077 importée deux fois) : repérage d'une facture
// VALIDÉE du même fournisseur portant le même numéro. Lecture seule : la garantie comptable reste l'index partiel « une
// facture validée par (fournisseur, numéro) » et le refus à la validation ; ce module ne sert qu'à prévenir et à signaler.
import type { Prisma } from "@prisma/client"

/** Ce qu'on compare : le numéro (même égalité stricte que la validation) et l'identité du fournisseur. */
export interface DuplicateProbe { number: string; supplierName: string; siret: string | null }
export interface ValidatedCandidate { id: string; number: string; supplierName: string; siret: string | null; supplier: { name: string; siret: string | null } | null }

const name = (s: string) => s.trim().toLowerCase()

/**
 * Même fournisseur, selon la règle de rattachement de la validation (findOrCreateSupplier) : même SIRET s'il est connu des
 * deux côtés, sinon même nom (casse ignorée). Même numéro : égalité stricte après suppression des espaces de bord.
 */
export function isSameInvoice(probe: DuplicateProbe, c: ValidatedCandidate): boolean {
  if (probe.number.trim() !== c.number.trim()) return false
  const siret = probe.siret?.trim() || null
  const candidateSirets = [c.siret, c.supplier?.siret].filter((v): v is string => !!v)
  if (siret && candidateSirets.length) return candidateSirets.includes(siret)
  return [c.supplierName, c.supplier?.name].some(n => !!n && name(n) === name(probe.supplierName))
}

type Db = { supplierInvoice: { findMany(args: Prisma.SupplierInvoiceFindManyArgs): Promise<unknown[]> } }

/**
 * Pour chaque sonde, l'identifiant d'une facture VALIDÉE qui la double (ou null). `exclude` : factures à ignorer (la sonde
 * elle-même). Une seule requête bornée par numéros, filtrée par société.
 */
export async function findValidatedDuplicates(db: Db, ctx: { companyId: string }, probes: readonly DuplicateProbe[], exclude: readonly string[] = []): Promise<(string | null)[]> {
  const numbers = [...new Set(probes.map(p => p.number.trim()).filter(Boolean))].slice(0, 200)
  if (!numbers.length) return probes.map(() => null)
  const candidates = await db.supplierInvoice.findMany({
    where: { companyId: ctx.companyId, status: "VALIDATED", number: { in: numbers }, ...(exclude.length ? { id: { notIn: [...exclude] } } : {}) },
    select: { id: true, number: true, supplierName: true, siret: true, supplier: { select: { name: true, siret: true } } },
    take: 500,
  }) as ValidatedCandidate[]
  return probes.map(p => candidates.find(c => isSameInvoice(p, c))?.id ?? null)
}
