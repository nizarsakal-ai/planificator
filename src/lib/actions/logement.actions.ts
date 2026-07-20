"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createLogementSchema } from "@/lib/validations/logement"
import { sendLogementCreatedEmail } from "@/lib/email"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) throw new Error("Non authentifié")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) throw new Error("Accès refusé")
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

// ─── Traitement automatique IA des réservations en attente ───────────────────

export async function autoProcessPendingAccommodations() {
  const user = await requireAdmin()

  if (!process.env.ANTHROPIC_API_KEY) return { error: "Clé API Anthropic non configurée." }

  const [pendings, teams, admin] = await Promise.all([
    prisma.pendingAccommodation.findMany({
      where:   { companyId: user.companyId!, status: "PENDING" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.team.findMany({
      where:  { companyId: user.companyId!, active: true },
      select: { id: true, name: true },
    }),
    prisma.user.findFirst({
      where:  { companyId: user.companyId!, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
      select: { id: true },
    }),
  ])

  if (pendings.length === 0) return { success: true, processed: 0, failed: 0 }

  const Anthropic = (await import("@anthropic-ai/sdk")).default
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const teamNames = teams.map((t) => t.name).join(", ")
  const today     = new Date().toISOString().split("T")[0]

  let processed = 0
  let failed    = 0

  for (const pending of pendings) {
    const emailText = [pending.propertyName, pending.rawEmailSnippet].filter(Boolean).join("\n")
    if (!emailText) { failed++; continue }

    try {
      const msg = await client.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: `Extrais les informations d'une réservation Booking.com.
Équipes disponibles: ${teamNames}
Aujourd'hui: ${today}
Réponds UNIQUEMENT en JSON valide sans markdown:
{
  "address": "adresse complète ou null",
  "city": "ville ou null",
  "zipCode": "code postal ou null",
  "teamName": "nom exact d'une équipe disponible ou null",
  "doorCode": "code porte ou null",
  "contactPhone": "téléphone ou null",
  "contactName": "nom contact ou null"
}
Pour teamName: cherche un prénom/nom qui correspond à une équipe disponible.`,
        messages: [{ role: "user", content: emailText }],
      })

      const content = msg.content[0]
      if (content.type !== "text") { failed++; continue }

      const extracted = JSON.parse(content.text)
      const finalAddress = pending.address || (extracted.address as string)?.trim() || null

      // Enrichir le pending avec les données extraites
      await prisma.pendingAccommodation.update({
        where: { id: pending.id },
        data: {
          address:      finalAddress,
          city:         (extracted.city         as string) || pending.city         || null,
          zipCode:      (extracted.zipCode      as string) || pending.zipCode      || null,
          doorCode:     (extracted.doorCode     as string) || pending.doorCode     || null,
          contactPhone: (extracted.contactPhone as string) || pending.contactPhone || null,
          contactName:  (extracted.contactName  as string) || pending.contactName  || null,
        },
      })

      // Matcher l'équipe — 1) par adresse déjà connue, 2) par nom extrait
      let teamId: string | null = null

      if (finalAddress) {
        const normalizeAddr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
        const allAcc = await prisma.accommodation.findMany({
          where: { companyId: user.companyId! },
          select: { teamId: true, address: true },
        })
        const addrPrefix = normalizeAddr(finalAddress).substring(0, 10)
        const match = allAcc.find(
          (a) => a.address && normalizeAddr(a.address).includes(addrPrefix)
        )
        if (match) teamId = match.teamId
      }

      // Fallback : nom d'équipe extrait par l'IA
      if (!teamId) {
        const teamName = extracted.teamName as string | null
        if (teamName) {
          const match = teams.find((t) =>
            t.name.toLowerCase() === teamName.toLowerCase() ||
            t.name.toLowerCase().includes(teamName.toLowerCase()) ||
            teamName.toLowerCase().includes(t.name.toLowerCase())
          )
          teamId = match?.id ?? null
        }
      }

      if (!teamId || !finalAddress || !pending.startDate || !pending.endDate || !admin) {
        failed++
        continue
      }

      // Confirmation automatique
      const notesValue = [pending.propertyName, pending.notes].filter(Boolean).join(" — ") || null

      await prisma.$transaction(async (tx) => {
        const created = await tx.accommodation.create({
          data: {
            companyId:    user.companyId!,
            teamId:       teamId!,
            createdById:  admin.id,
            startDate:    pending.startDate!,
            endDate:      pending.endDate!,
            address:      finalAddress!,
            city:         (extracted.city         as string) || pending.city         || null,
            zipCode:      (extracted.zipCode      as string) || pending.zipCode      || null,
            doorCode:     (extracted.doorCode     as string) || pending.doorCode     || null,
            contactName:  (extracted.contactName  as string) || pending.contactName  || null,
            contactPhone: (extracted.contactPhone as string) || pending.contactPhone || null,
            notes:        notesValue,
            gmailSourceMessageId: pending.gmailMessageId,
            source: "gmail-scan",
          },
        })

        await tx.pendingAccommodation.update({
          where: { id: pending.id },
          data: {
            status:          "CONFIRMED",
            accommodationId: created.id,
            confirmedById:   user.id,
            confirmedAt:     new Date(),
          },
        })
      })

      processed++
    } catch {
      failed++
    }
  }

  revalidatePath("/logements")
  revalidatePath("/planning/moi")
  return { success: true, processed, failed }
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
