/**
 * PLAN-ACQ-V2 Lot G R2 — Matching client + anti-doublon chantier.
 * Normalisation identique draft / chantier (casse, accents, ponctuation).
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type ClientMatchResult = {
  clientId: string | null
  matchKind: "PROPOSED_ID" | "EMAIL" | "NAME" | "NONE"
  /** true si plusieurs clients actifs matchent le même critère (ambigu). */
  ambiguous?: boolean
}

export async function matchClientForDraft(input: {
  companyId: string
  clientName: string | null
  clientEmail: string | null
  proposedClientId?: string | null
  db?: PrismaClient
}): Promise<ClientMatchResult> {
  const db = input.db ?? prisma

  if (input.proposedClientId) {
    const byId = await db.client.findFirst({
      where: {
        id: input.proposedClientId,
        companyId: input.companyId,
        active: true,
      },
      select: { id: true },
    })
    if (byId) return { clientId: byId.id, matchKind: "PROPOSED_ID" }
  }

  const email = input.clientEmail?.trim().toLowerCase() ?? ""
  if (email) {
    const byEmail = await db.client.findMany({
      where: {
        companyId: input.companyId,
        active: true,
        email: { equals: email, mode: "insensitive" },
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    })
    if (byEmail.length > 1) {
      return { clientId: null, matchKind: "EMAIL", ambiguous: true }
    }
    if (byEmail.length === 1) {
      return { clientId: byEmail[0].id, matchKind: "EMAIL" }
    }
  }

  const name = input.clientName?.trim() ?? ""
  if (name.length >= 2) {
    const byName = await db.client.findMany({
      where: {
        companyId: input.companyId,
        active: true,
        name: { equals: name, mode: "insensitive" },
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 5,
    })
    if (byName.length > 1) {
      return { clientId: null, matchKind: "NAME", ambiguous: true }
    }
    if (byName.length === 1) {
      return { clientId: byName[0].id, matchKind: "NAME" }
    }
  }

  return { clientId: null, matchKind: "NONE" }
}

/** Normalise un fragment (casse, accents, ponctuation → espaces). */
export function normalizeAddressPart(value: string | null | undefined): string {
  if (value == null) return ""
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Clé canonique adresse — même algo pour draft (composants) et chantier (blob stocké).
 * Forme stockée chantier : "street, postalCode, city" (buildWorksiteAddress).
 */
export function normalizeAddressKey(parts: {
  address?: string | null
  postalCode?: string | null
  city?: string | null
}): string {
  const street = normalizeAddressPart(parts.address)
  const cp = normalizeAddressPart(parts.postalCode)
  const city = normalizeAddressPart(parts.city)
  return [street, cp, city].filter(Boolean).join("|")
}

/**
 * Normalise une adresse chantier déjà jointe ("a, cp, city") vers la même clé.
 * Heuristique : dernier token numérique-ish = CP, avant-dernier = ville si ≥2 virgules.
 */
export function normalizeStoredWorksiteAddress(stored: string | null | undefined): string {
  if (stored == null || !stored.trim()) return ""
  const raw = stored.trim()
  const commaParts = raw.split(",").map((p) => p.trim()).filter(Boolean)
  if (commaParts.length >= 3) {
    const city = commaParts[commaParts.length - 1]
    const postalCode = commaParts[commaParts.length - 2]
    const address = commaParts.slice(0, -2).join(", ")
    return normalizeAddressKey({ address, postalCode, city })
  }
  if (commaParts.length === 2) {
    const [a, b] = commaParts
    if (/^\d{4,10}[a-zA-Z]?$/.test(b.replace(/\s/g, ""))) {
      return normalizeAddressKey({ address: a, postalCode: b, city: null })
    }
    return normalizeAddressKey({ address: a, postalCode: null, city: b })
  }
  return normalizeAddressKey({ address: raw, postalCode: null, city: null })
}

export type DuplicateWorksiteHit = {
  worksiteId: string | null
  matchKind: "ADDRESS" | "REFERENCE" | "NONE"
}

/**
 * Recherche doublon probable — scoped companyId, statuts actifs.
 * Pas de take arbitraire 200 : filtre postal si présent, sinon scan tenant borné raisonnable via updatedAt.
 * Justification : index companyId+status ; volumes chantiers actifs par tenant restent modestes.
 * Si postal présent → where address contains postal (réduction forte).
 */
export async function findDuplicateWorksite(input: {
  companyId: string
  addressKey: string
  postalCode?: string | null
  consultationReference?: string | null
  db?: {
    worksite: {
      findMany: PrismaClient["worksite"]["findMany"]
    }
  }
}): Promise<DuplicateWorksiteHit> {
  const db = input.db ?? prisma
  if (!input.addressKey && !input.consultationReference?.trim()) {
    return { worksiteId: null, matchKind: "NONE" }
  }

  const postal = normalizeAddressPart(input.postalCode)
  const where: {
    companyId: string
    status: { in: Array<"PLANNED" | "IN_PROGRESS" | "EXTENDED"> }
    address?: { contains: string; mode: "insensitive" }
  } = {
    companyId: input.companyId,
    status: { in: ["PLANNED", "IN_PROGRESS", "EXTENDED"] },
  }
  if (postal) {
    where.address = { contains: postal, mode: "insensitive" }
  }

  const candidates = await db.worksite.findMany({
    where,
    select: { id: true, address: true, name: true },
    orderBy: { updatedAt: "desc" },
    // Garde-fou mémoire : 2000 max si pas de filtre postal (tenant atypique).
    take: postal ? 500 : 2000,
  })

  const ref = input.consultationReference?.trim().toUpperCase() ?? ""
  for (const w of candidates) {
    const key = normalizeStoredWorksiteAddress(w.address)
    if (input.addressKey && key && key === input.addressKey) {
      return { worksiteId: w.id, matchKind: "ADDRESS" }
    }
  }
  if (ref) {
    for (const w of candidates) {
      if (w.name.toUpperCase().includes(ref)) {
        return { worksiteId: w.id, matchKind: "REFERENCE" }
      }
    }
  }
  return { worksiteId: null, matchKind: "NONE" }
}
