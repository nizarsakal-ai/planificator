"use server"
import { auth, unstable_update } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"

export async function switchCompany(formData: FormData) {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  const companyId = String(formData.get("companyId") ?? "")
  const membership = await prisma.employee.findFirst({
    where: { userId: session.user.id, companyId, active: true, company: { active: true } },
  })
  const primary = await prisma.user.findFirst({ where: {
    id: session.user.id, companyId, active: true, company: { active: true },
    employeeProfiles: { none: { companyId } },
  } })
  if (!membership && !primary) throw new Error("Accès refusé")
  await unstable_update({ user: { companyId } })
  redirect("/dashboard")
}
