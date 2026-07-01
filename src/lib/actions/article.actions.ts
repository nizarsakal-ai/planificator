"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { articleSchema } from "@/lib/validations/article"

// Bibliothèque d'articles réservée aux administrateurs (pas TEAM_LEADER).
async function requireArticleAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

function parseForm(formData: FormData) {
  return articleSchema.safeParse({
    reference:   (formData.get("reference")   as string) || undefined,
    designation: formData.get("designation")  as string,
    description: (formData.get("description") as string) || undefined,
    unit:        (formData.get("unit")        as string) || "u",
    unitPrice:   formData.get("unitPrice")    as string,
    vatRate:     formData.get("vatRate")      as string,
  })
}

// ─── Créer un article ────────────────────────────────────────────────────────
export async function createArticle(formData: FormData) {
  const user = await requireArticleAdmin()

  const parsed = parseForm(formData)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.article.create({
    data: {
      companyId:   user.companyId!,
      reference:   parsed.data.reference   || null,
      designation: parsed.data.designation,
      description: parsed.data.description || null,
      unit:        parsed.data.unit,
      unitPrice:   parsed.data.unitPrice,
      vatRate:     parsed.data.vatRate,
    },
  })

  revalidatePath("/articles")
  return { success: true }
}

// ─── Modifier un article ─────────────────────────────────────────────────────
export async function updateArticle(id: string, formData: FormData) {
  const user = await requireArticleAdmin()

  const existing = await prisma.article.findFirst({
    where:  { id, companyId: user.companyId! },
    select: { id: true },
  })
  if (!existing) return { error: "Article introuvable." }

  const parsed = parseForm(formData)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  await prisma.article.update({
    where: { id },
    data: {
      reference:   parsed.data.reference   || null,
      designation: parsed.data.designation,
      description: parsed.data.description || null,
      unit:        parsed.data.unit,
      unitPrice:   parsed.data.unitPrice,
      vatRate:     parsed.data.vatRate,
    },
  })

  revalidatePath("/articles")
  return { success: true }
}

// ─── Supprimer un article (suppression douce) ────────────────────────────────
export async function deleteArticle(id: string) {
  const user = await requireArticleAdmin()

  const { count } = await prisma.article.updateMany({
    where: { id, companyId: user.companyId!, active: true },
    data:  { active: false },
  })
  if (count === 0) return { error: "Article introuvable." }

  revalidatePath("/articles")
  return { success: true }
}
