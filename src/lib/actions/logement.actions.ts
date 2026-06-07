"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createLogementSchema } from "@/lib/validations/logement"
import { sendLogementCreatedEmail } from "@/lib/email"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) throw new Error("Accès refusé")
  if (!session.user.companyId) throw new Error("Entreprise introuvable")
  return session.user
}

// ─── Parser le texte libre avec l'IA ────────────────────────────────────────

export async function parseLogementText(rawText: string) {
  const user = await requireAdmin()
  void user // auth check only

  if (!rawText?.trim()) return { error: "Texte vide." }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "Clé API Anthropic non configurée. Veuillez utiliser le formulaire manuel." }
  }

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const today = new Date().toISOString().split("T")[0]

    const systemPrompt = `Tu es un assistant qui extrait des informations de réservation de logement depuis un texte en français.
Aujourd'hui nous sommes le ${today}. Si l'utilisateur dit "juin" sans année, utilise l'année en cours (${new Date().getFullYear()}).
Réponds UNIQUEMENT en JSON valide, sans markdown, sans explication, sans balises de code.
Format attendu (toutes les valeurs peuvent être null si non trouvées) :
{
  "teamName": "string ou null",
  "startDate": "YYYY-MM-DD ou null",
  "endDate": "YYYY-MM-DD ou null",
  "address": "string ou null",
  "city": "string ou null",
  "zipCode": "string ou null",
  "doorCode": "string ou null",
  "contactName": "string ou null",
  "contactPhone": "string ou null",
  "notes": "string ou null"
}`

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Extrais les informations de réservation depuis ce texte :\n\n${rawText}`,
        },
      ],
    })

    const content = message.content[0]
    if (content.type !== "text") return { error: "Réponse IA inattendue." }

    const parsed = JSON.parse(content.text)
    return { success: true, data: parsed }
  } catch (err) {
    console.error("[parseLogementText]", err)
    return { error: "L'IA n'a pas pu analyser ce texte. Essayez le formulaire manuel." }
  }
}

// ─── Créer un logement ───────────────────────────────────────────────────────

export async function createLogement(formData: FormData) {
  const user = await requireAdmin()

  const raw = {
    teamId:       formData.get("teamId")       as string,
    startDate:    formData.get("startDate")    as string,
    endDate:      formData.get("endDate")      as string,
    address:      formData.get("address")      as string,
    city:         formData.get("city")         as string || undefined,
    zipCode:      formData.get("zipCode")      as string || undefined,
    doorCode:     formData.get("doorCode")     as string || undefined,
    contactName:  formData.get("contactName")  as string || undefined,
    contactPhone: formData.get("contactPhone") as string || undefined,
    notes:        formData.get("notes")        as string || undefined,
  }

  const parsed = createLogementSchema.safeParse(raw)
  if (!parsed.success) return { error: parsed.error.errors[0].message }

  const team = await prisma.team.findFirst({
    where: { id: parsed.data.teamId, companyId: user.companyId! },
    include: {
      leader: { select: { userId: true } },
      members: {
        where: { leftAt: null },
        include: {
          employee: {
            select: {
              userId: true,
              firstName: true,
              lastName: true,
              user: { select: { email: true } },
            },
          },
        },
      },
    },
  })
  if (!team) return { error: "Équipe introuvable." }

  const startDate = new Date(parsed.data.startDate)
  const endDate   = new Date(parsed.data.endDate)

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(d)
  const startLabel = fmtDate(startDate)
  const endLabel   = fmtDate(endDate)

  // Collecter tous les userId à notifier
  const userIds = [
    team.leader.userId,
    ...team.members.map((m) => m.employee.userId),
  ].filter(Boolean) as string[]

  const accommodation = await prisma.$transaction(async (tx) => {
    const acc = await tx.accommodation.create({
      data: {
        companyId:    user.companyId!,
        teamId:       parsed.data.teamId,
        createdById:  user.id,
        startDate,
        endDate,
        address:      parsed.data.address,
        city:         parsed.data.city     || null,
        zipCode:      parsed.data.zipCode  || null,
        doorCode:     parsed.data.doorCode || null,
        contactName:  parsed.data.contactName  || null,
        contactPhone: parsed.data.contactPhone || null,
        notes:        parsed.data.notes    || null,
      },
    })

    if (userIds.length > 0) {
      await tx.notification.createMany({
        data: userIds.map((userId) => ({
          userId,
          companyId: user.companyId!,
          type:      "ACCOMMODATION_CREATED" as const,
          title:     `Logement réservé — ${team.name}`,
          message:   `Un logement a été réservé pour votre équipe du ${startLabel} au ${endLabel}.`,
          link:      `/planning/moi`,
        })),
      })
    }

    return acc
  })

  // Emails fire-and-forget
  const company = await prisma.company.findUnique({
    where: { id: user.companyId! },
    select: { name: true },
  })

  for (const membre of team.members) {
    const email = membre.employee.user?.email
    if (!email) continue
    sendLogementCreatedEmail({
      to:           email,
      recipientName: `${membre.employee.firstName} ${membre.employee.lastName}`,
      teamName:     team.name,
      address:      `${parsed.data.address}${parsed.data.city ? `, ${parsed.data.city}` : ""}`,
      startLabel,
      endLabel,
      doorCode:     parsed.data.doorCode,
      contactPhone: parsed.data.contactPhone,
      companyName:  company?.name ?? "",
    }).catch(() => {})
  }

  void accommodation

  revalidatePath("/logements")
  revalidatePath("/planning/moi")
  return { success: true }
}

// ─── Supprimer un logement ────────────────────────────────────────────────────

export async function deleteLogement(id: string) {
  const user = await requireAdmin()

  const acc = await prisma.accommodation.findFirst({
    where: { id, companyId: user.companyId! },
  })
  if (!acc) return { error: "Logement introuvable." }

  await prisma.accommodation.delete({ where: { id } })

  revalidatePath("/logements")
  revalidatePath("/planning/moi")
  return { success: true }
}
