"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { z } from "zod"

const updateCompanySchema = z.object({
  name:    z.string().min(1, "Le nom est requis").max(100),
  email:   z.string().email("Email invalide").optional().or(z.literal("")),
  phone:   z.string().optional(),
  address: z.string().optional(),
  siret:   z.string().optional(),
})

const updateSettingsSchema = z.object({
  defaultDailyHours: z.coerce.number().min(1).max(24).default(10),
  timezone:          z.string().optional(),
})

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

export async function updateCompanyInfo(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:    (formData.get("name")    as string) || "",
    email:   (formData.get("email")   as string) || "",
    phone:   (formData.get("phone")   as string) || "",
    address: (formData.get("address") as string) || "",
    siret:   (formData.get("siret")   as string) || "",
  }

  const parsed = updateCompanySchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.company.update({
    where: { id: user.companyId! },
    data: {
      name:    parsed.data.name,
      email:   parsed.data.email   || null,
      phone:   parsed.data.phone   || null,
      address: parsed.data.address || null,
      siret:   parsed.data.siret   || null,
    },
  })

  revalidatePath("/parametres")
  return { success: true }
}

export async function updateCompanySettings(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    defaultDailyHours: formData.get("defaultDailyHours") as string,
    timezone:          formData.get("timezone")          as string,
  }

  const parsed = updateSettingsSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.companySettings.upsert({
    where:  { companyId: user.companyId! },
    create: {
      companyId:         user.companyId!,
      defaultDailyHours: parsed.data.defaultDailyHours,
      timezone:          parsed.data.timezone || "Europe/Paris",
    },
    update: {
      defaultDailyHours: parsed.data.defaultDailyHours,
      timezone:          parsed.data.timezone || "Europe/Paris",
    },
  })

  revalidatePath("/parametres")
  return { success: true }
}
