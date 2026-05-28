"use server"

import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { revalidatePath } from "next/cache"
import { sendInvitationEmail } from "@/lib/email"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { z } from "zod"

// ─── Utilitaire slug ─────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base
  let i = 1
  while (await prisma.company.findUnique({ where: { slug } })) {
    slug = `${base}-${i++}`
  }
  return slug
}

// ─── Inscription publique ─────────────────────────────────────────────────────

const registerSchema = z.object({
  companyName: z.string().min(2, "Nom de l'entreprise requis (2 caractères min.)"),
  adminName:   z.string().min(2, "Votre nom est requis"),
  email:       z.string().email("Email invalide"),
  password:    z.string().min(8, "8 caractères minimum"),
})

export async function registerCompany(formData: FormData) {
  const raw = {
    companyName: (formData.get("companyName") as string)?.trim(),
    adminName:   (formData.get("adminName")   as string)?.trim(),
    email:       (formData.get("email")       as string)?.trim().toLowerCase(),
    password:    formData.get("password")     as string,
  }

  const parsed = registerSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const existingUser = await prisma.user.findUnique({ where: { email: parsed.data.email } })
  if (existingUser) return { error: "Cet email est déjà utilisé." }

  const slug   = await uniqueSlug(toSlug(parsed.data.companyName))
  const hashed = await bcrypt.hash(parsed.data.password, 12)

  await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: { name: parsed.data.companyName, slug },
    })
    await tx.companySettings.create({
      data: { companyId: company.id, defaultDailyHours: 8 },
    })
    await tx.user.create({
      data: {
        email:     parsed.data.email,
        name:      parsed.data.adminName,
        password:  hashed,
        role:      "ADMIN",
        companyId: company.id,
      },
    })
  })

  return { success: true }
}

// ─── Création entreprise par le Super Admin ───────────────────────────────────

const createCompanySchema = z.object({
  companyName: z.string().min(2, "Nom de l'entreprise requis"),
  adminEmail:  z.string().email("Email invalide").optional().or(z.literal("")),
})

export async function createCompanyAsAdmin(formData: FormData) {
  const session = await auth()
  if (!session?.user || session.user.role !== "SUPER_ADMIN") {
    return { error: "Non autorisé" }
  }

  const raw = {
    companyName: (formData.get("companyName") as string)?.trim(),
    adminEmail:  (formData.get("adminEmail")  as string)?.trim().toLowerCase() || "",
  }

  const parsed = createCompanySchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const slug = await uniqueSlug(toSlug(parsed.data.companyName))

  const company = await prisma.$transaction(async (tx) => {
    const c = await tx.company.create({
      data: { name: parsed.data.companyName, slug },
    })
    await tx.companySettings.create({
      data: { companyId: c.id, defaultDailyHours: 8 },
    })
    return c
  })

  // Inviter le premier admin si email fourni
  if (parsed.data.adminEmail) {
    const existing = await prisma.user.findUnique({ where: { email: parsed.data.adminEmail } })
    if (!existing) {
      const token   = crypto.randomBytes(32).toString("hex")
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

      await prisma.invitation.create({
        data: {
          email:       parsed.data.adminEmail,
          role:        "ADMIN",
          companyId:   company.id,
          invitedById: session.user.id,
          token,
          expiresAt:   expires,
          status:      "PENDING",
        },
      })

      if (process.env.RESEND_API_KEY) {
        sendInvitationEmail({
          to:            parsed.data.adminEmail,
          token,
          companyName:   company.name,
          invitedByName: "Planificator",
          role:          "ADMIN",
        }).catch(() => {})
      }
    }
  }

  revalidatePath("/super-admin/entreprises")
  return { success: true }
}
