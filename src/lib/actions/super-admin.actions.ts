"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"

async function requireSuperAdmin() {
  const session = await auth()
  if (!session?.user || session.user.role !== "SUPER_ADMIN") {
    throw new Error("Accès refusé")
  }
}

export async function toggleCompanyActive(companyId: string) {
  await requireSuperAdmin()

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, active: true },
  })
  if (!company) throw new Error("Entreprise introuvable")

  await prisma.company.update({
    where: { id: companyId },
    data:  { active: !company.active },
  })

  revalidatePath("/super-admin/entreprises")
}

export async function deleteCompany(companyId: string) {
  await requireSuperAdmin()

  // Lot B (ADR-PLAN-003) : une société qui possède des factures ne peut pas être supprimée (conservation).
  const invoiceCount = await prisma.invoice.count({ where: { companyId } })
  if (invoiceCount > 0) {
    return { error: "Cette entreprise possède des factures : désactivez-la au lieu de la supprimer." }
  }

  try {
    await prisma.company.delete({ where: { id: companyId } })
  } catch (error) {
    // Facture créée entre le contrôle et la suppression : la contrainte Restrict refuse (P2003).
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2003") {
      return { error: "Cette entreprise possède des factures : désactivez-la au lieu de la supprimer." }
    }
    throw error
  }

  revalidatePath("/super-admin/entreprises")
  return { success: true }
}
