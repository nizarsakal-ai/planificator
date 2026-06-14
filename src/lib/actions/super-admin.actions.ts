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

  await prisma.company.delete({ where: { id: companyId } })

  revalidatePath("/super-admin/entreprises")
}
