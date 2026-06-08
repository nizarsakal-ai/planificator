"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createClientSchema, updateClientSchema } from "@/lib/validations/client"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Créer un client ─────────────────────────────────────────────────────────

export async function createClient(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:    formData.get("name")    as string,
    email:   formData.get("email")   as string,
    phone:   formData.get("phone")   as string,
    address: formData.get("address") as string,
    notes:   formData.get("notes")   as string,
  }

  const parsed = createClientSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.client.create({
    data: {
      name:      parsed.data.name,
      email:     parsed.data.email || null,
      phone:     parsed.data.phone || null,
      address:   parsed.data.address || null,
      notes:     parsed.data.notes || null,
      companyId: user.companyId!,
    },
  })

  revalidatePath("/clients")
  return { success: true }
}

// ─── Modifier un client ───────────────────────────────────────────────────────

export async function updateClient(clientId: string, formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    name:    formData.get("name")    as string,
    email:   formData.get("email")   as string,
    phone:   formData.get("phone")   as string,
    address: formData.get("address") as string,
    notes:   formData.get("notes")   as string,
  }

  const parsed = updateClientSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  await prisma.client.update({
    where: { id: clientId },
    data: {
      name:    parsed.data.name,
      email:   parsed.data.email || null,
      phone:   parsed.data.phone || null,
      address: parsed.data.address || null,
      notes:   parsed.data.notes || null,
    },
  })

  revalidatePath("/clients")
  return { success: true }
}

// ─── Activer / Désactiver un client ──────────────────────────────────────────

export async function toggleClientActive(clientId: string, active: boolean) {
  const user = await requireAdmin()

  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId: user.companyId! },
  })
  if (!client) return { error: "Client introuvable." }

  await prisma.client.update({
    where: { id: clientId },
    data: { active },
  })

  revalidatePath("/clients")
  return { success: true }
}
