import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { decrypt, encrypt } from "@/lib/encryption"
import Anthropic from "@anthropic-ai/sdk"

// Helper : extrait le texte d'un message Gmail (payload récursif)
function extractTextFromParts(parts: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[]): string {
  let text = ""
  for (const part of parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      text += Buffer.from(part.body.data, "base64url").toString("utf8")
    } else if (part.mimeType === "text/html" && part.body?.data && !text) {
      const html = Buffer.from(part.body.data, "base64url").toString("utf8")
      text += html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    } else if (part.parts) {
      text += extractTextFromParts(part.parts as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[])
    }
  }
  return text
}

function extractMessageBody(payload: { body?: { data?: string }; parts?: unknown[] } | undefined): string {
  if (!payload) return ""
  if (payload.parts) return extractTextFromParts(payload.parts as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[])
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8")
  return ""
}

// ── Regex fallback parser (used when Claude API is unavailable) ────────────
const FRENCH_MONTHS: Record<string, string> = {
  janvier: "01", février: "02", fevrier: "02", mars: "03", avril: "04",
  mai: "05", juin: "06", juillet: "07", août: "08", aout: "08",
  septembre: "09", octobre: "10", novembre: "11", décembre: "12", decembre: "12",
}

function parseFrenchDate(raw: string): string | null {
  // "15 janvier 2025" or "15 jan. 2025"
  const m = raw.match(/(\d{1,2})\s+([a-zéûô\.]+)\s+(\d{4})/i)
  if (m) {
    const day   = m[1].padStart(2, "0")
    const month = FRENCH_MONTHS[m[2].toLowerCase().replace(".", "")] ?? null
    if (month) return `${m[3]}-${month}-${day}`
  }
  // "2025-01-15" or "15/01/2025"
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const slashes = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (slashes) return `${slashes[3]}-${slashes[2].padStart(2, "0")}-${slashes[1].padStart(2, "0")}`
  return null
}

function regexFallbackParser(text: string): Record<string, string | null> {
  const result: Record<string, string | null> = {
    propertyName: null, address: null, city: null, zipCode: null,
    startDate: null, endDate: null, doorCode: null, contactPhone: null,
    contactName: null, teamName: null, notes: null,
  }

  // propertyName – lines that look like a heading before the address block
  const propMatch = text.match(/(?:appartement|appart|logement|villa|studio|maison|résidence)\s*[:\-]?\s*([A-Z][^\n]{3,60})/i)
  if (propMatch) result.propertyName = propMatch[1].trim()

  // address – street with number
  const addrMatch = text.match(/(\d{1,4}[\s,]+(?:rue|avenue|av\.|boulevard|bd\.?|chemin|impasse|allée|place|route|voie)[^\n,]{3,60})/i)
  if (addrMatch) result.address = addrMatch[1].trim()

  // zipCode – 5-digit French postal code
  const zipMatch = text.match(/\b((?:0[1-9]|[1-8]\d|9[0-5])\d{3})\b/)
  if (zipMatch) result.zipCode = zipMatch[1]

  // city – word(s) after the zip code
  if (result.zipCode) {
    const cityMatch = text.match(new RegExp(result.zipCode + "\\s+([A-ZÀ-Ÿ][a-zà-ÿA-ZÀ-Ÿ\\s\\-]{2,40})"))
    if (cityMatch) result.city = cityMatch[1].trim()
  }

  // Date pattern: optional day-of-week, then "8 juin 2026" or "08/06/2026" or "2026-06-08"
  const DATE_PAT = "(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)?\\s*(\\d{1,2}[\\s\\/\\-][a-zéûôA-Z\\d]{2,12}[\\s\\/\\-]\\d{4}|\\d{4}-\\d{2}-\\d{2})"

  // startDate – "Arrivée", "check-in" followed by optional day name + date
  const startMatch = text.match(new RegExp("(?:arrivée|arrivee|check[\\s\\-]in)[\\s\\S]{0,30}?" + DATE_PAT, "i"))
  if (startMatch) result.startDate = parseFrenchDate(startMatch[1] ?? startMatch[0])

  // endDate – "Départ", "check-out"
  const endMatch = text.match(new RegExp("(?:départ|depart|check[\\s\\-]out)[\\s\\S]{0,30}?" + DATE_PAT, "i"))
  if (endMatch) result.endDate = parseFrenchDate(endMatch[1] ?? endMatch[0])

  // Fallback: "du [date] au [date]" pattern
  if (!result.startDate || !result.endDate) {
    const duAuMatch = text.match(/du\s+(\d{1,2}\s+[a-zéûô]+\s+\d{4})\s+au\s+(\d{1,2}\s+[a-zéûô]+\s+\d{4})/i)
    if (duAuMatch) {
      if (!result.startDate) result.startDate = parseFrenchDate(duAuMatch[1])
      if (!result.endDate)   result.endDate   = parseFrenchDate(duAuMatch[2])
    }
  }

  // doorCode – code / digicode followed by digits (or mixed alphanumeric ≤ 10 chars)
  const doorMatch = text.match(/(?:code[^:]*|digicode[^:]*)\s*[:\-]\s*([A-Z0-9#\*]{3,10})/i)
  if (doorMatch) result.doorCode = doorMatch[1].trim()

  // contactPhone – French phone number patterns
  const phoneMatch = text.match(/(?:\+33|0033|0)\s*[1-9](?:[\s.\-]?\d{2}){4}/)
  if (phoneMatch) result.contactPhone = phoneMatch[0].replace(/\s/g, "")

  // teamName – "guest [Name]", "for guest [Name]", "réservation de [Name]", "booked by [Name]"
  const teamMatch = text.match(/(?:for\s+guest|guest|réservation de|reservation de|booked by)\s+([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝ][a-zà-ÿ]+(?:\s+[A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖÙÚÛÜÝ][a-zà-ÿ]+)?)/i)
  if (teamMatch) result.teamName = teamMatch[1].trim()

  return result
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const connections = await prisma.gmailConnection.findMany()
  const stats = { scanned: 0, detected: 0, errors: 0 }
  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null

  for (const conn of connections) {
    try {
      // ── Rafraîchir le token si proche de l'expiration (marge 5 min) ──
      let accessToken = decrypt(conn.accessToken)
      const expirySoon = conn.tokenExpiry < new Date(Date.now() + 5 * 60 * 1000)

      if (expirySoon) {
        const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body:    new URLSearchParams({
            client_id:     process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            refresh_token: decrypt(conn.refreshToken),
            grant_type:    "refresh_token",
          }),
        })
        const refreshData = await refreshRes.json()
        if (!refreshData.access_token) {
          console.error(`[gmail-scan] Token refresh failed for company ${conn.companyId}:`, refreshData.error)
          stats.errors++
          continue
        }
        accessToken = refreshData.access_token
        await prisma.gmailConnection.update({
          where: { id: conn.id },
          data:  {
            accessToken: encrypt(refreshData.access_token),
            tokenExpiry: new Date(Date.now() + (refreshData.expires_in ?? 3600) * 1000),
          },
        })
      }

      // ── Rechercher les emails Booking.com ──────────────────────────────
      const listRes  = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from:noreply@booking.com&maxResults=50",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      const listData = await listRes.json()
      if (!listData.messages?.length) continue

      // ── Exclure les messages déjà traités ─────────────────────────────
      const messageIds = (listData.messages as { id: string }[]).map((m) => m.id)
      const processed  = await prisma.processedGmailMessage.findMany({
        where:  { companyId: conn.companyId, messageId: { in: messageIds } },
        select: { messageId: true },
      })
      const processedSet = new Set(processed.map((p) => p.messageId))
      const newMessages  = (listData.messages as { id: string }[]).filter((m) => !processedSet.has(m.id))
      if (!newMessages.length) continue

      for (const msg of newMessages) {
        try {
          stats.scanned++

          // Marquer immédiatement pour éviter les doublons en cas d'erreur partielle
          await prisma.processedGmailMessage.create({
            data: { companyId: conn.companyId, messageId: msg.id },
          })

          // ── Récupérer le corps complet du message ──────────────────────
          const msgRes  = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          )
          const msgData = await msgRes.json()
          const bodyText = extractMessageBody(msgData.payload)
          const snippet  = (msgData.snippet ?? "") as string

          if (!bodyText && !snippet) continue

          // ── Analyser avec Claude (avec fallback regex si API indisponible) ──
          let parsed: Record<string, string | null>
          const emailText = (bodyText || snippet).substring(0, 4000)

          let usedFallback = false
          if (anthropic) {
            try {
              const today = new Date().toISOString().split("T")[0]
              const aiRes = await anthropic.messages.create({
                model:      "claude-haiku-4-5-20251001",
                max_tokens: 512,
                system: `Tu analyses des emails de confirmation Booking.com et extrais les informations de logement.
Aujourd'hui nous sommes le ${today}.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans balises de code.
Format (toutes les valeurs peuvent être null si non trouvées) :
{
  "propertyName": "nom du logement",
  "address": "adresse complète (rue + numéro)",
  "city": "ville",
  "zipCode": "code postal",
  "startDate": "YYYY-MM-DD (date d'arrivée/check-in)",
  "endDate": "YYYY-MM-DD (date de départ/check-out)",
  "doorCode": "code d'accès ou digicode si mentionné",
  "contactName": "nom du propriétaire ou hôte",
  "contactPhone": "numéro de téléphone de contact",
  "notes": "numéro de confirmation et autres infos utiles",
  "teamName": "prénom ou nom de l'équipe mentionné dans la réservation (ex: dans 'Réservation de Makram', extraire 'Makram'). null si non trouvé."
}`,
                messages: [{ role: "user", content: `Email à analyser :\n\n${emailText}` }],
              })

              const aiContent = aiRes.content[0]
              if (aiContent.type !== "text") {
                console.warn(`[gmail-scan] Unexpected AI content type for message ${msg.id}, switching to regex fallback`)
                parsed = regexFallbackParser(emailText)
                usedFallback = true
              } else {
                try {
                  parsed = JSON.parse(aiContent.text)
                } catch {
                  console.warn(`[gmail-scan] AI JSON parse error for message ${msg.id}, switching to regex fallback`)
                  parsed = regexFallbackParser(emailText)
                  usedFallback = true
                }
              }
            } catch (claudeErr) {
              console.warn(`[gmail-scan] Claude API error for message ${msg.id}, switching to regex fallback:`, claudeErr)
              parsed = regexFallbackParser(emailText)
              usedFallback = true
            }
          } else {
            console.warn(`[gmail-scan] No ANTHROPIC_API_KEY – using regex fallback for message ${msg.id}`)
            parsed = regexFallbackParser(emailText)
            usedFallback = true
          }

          if (usedFallback) {
            console.log(`[gmail-scan] Regex fallback result for ${msg.id}:`, JSON.stringify(parsed))
          }

          // If the fallback found nothing useful, skip this message
          const hasUsefulData = parsed.address || parsed.startDate || parsed.endDate || parsed.propertyName
          if (!hasUsefulData) {
            console.log(`[gmail-scan] No useful data extracted for message ${msg.id}, skipping`)
            continue
          }

          // ── Chercher l'admin pour createdById ─────────────────────────
          const admin = await prisma.user.findFirst({
            where:  { companyId: conn.companyId, role: { in: ["SUPER_ADMIN", "ADMIN"] } },
            select: { id: true },
          })

          // ── Chercher l'équipe par nom si extrait ──────────────────────
          let matchedTeamId: string | null = null
          if (parsed.teamName) {
            const team = await prisma.team.findFirst({
              where: {
                companyId: conn.companyId,
                active:    true,
                name:      { contains: parsed.teamName, mode: "insensitive" },
              },
              select: { id: true },
            })
            matchedTeamId = team?.id ?? null
          }

          // ── Créer directement le logement si équipe trouvée ──────────
          if (matchedTeamId && admin && parsed.address && parsed.startDate && parsed.endDate) {
            await prisma.accommodation.create({
              data: {
                companyId:   conn.companyId,
                teamId:      matchedTeamId,
                createdById: admin.id,
                address:     parsed.address,
                city:        parsed.city        ?? null,
                zipCode:     parsed.zipCode     ?? null,
                startDate:   new Date(parsed.startDate),
                endDate:     new Date(parsed.endDate),
                doorCode:    parsed.doorCode    ?? null,
                contactName: parsed.contactName ?? null,
                contactPhone:parsed.contactPhone?? null,
                notes:       parsed.notes       ?? null,
              },
            })

            // Notifier les admins — logement créé automatiquement
            const admins = await prisma.user.findMany({
              where:  { companyId: conn.companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
              select: { id: true },
            })
            const dateInfo = ` du ${parsed.startDate} au ${parsed.endDate}`
            await prisma.notification.createMany({
              data: admins.map((a) => ({
                userId:    a.id,
                companyId: conn.companyId,
                type:      "BOOKING_DETECTED" as const,
                title:     "Logement créé automatiquement",
                message:   `${parsed.propertyName ?? parsed.address}${dateInfo} — Équipe ${parsed.teamName} affectée.`,
                link:      "/logements",
              })),
            })
          } else {
            // ── Fallback : réservation en attente si équipe non trouvée ──
            await prisma.pendingAccommodation.create({
              data: {
                companyId:       conn.companyId,
                gmailMessageId:  msg.id,
                propertyName:    parsed.propertyName  ?? null,
                address:         parsed.address       ?? null,
                city:            parsed.city          ?? null,
                zipCode:         parsed.zipCode       ?? null,
                startDate:       parsed.startDate ? new Date(parsed.startDate) : null,
                endDate:         parsed.endDate   ? new Date(parsed.endDate)   : null,
                doorCode:        parsed.doorCode      ?? null,
                contactName:     parsed.contactName   ?? null,
                contactPhone:    parsed.contactPhone  ?? null,
                notes:           parsed.notes         ?? null,
                rawEmailSnippet: snippet.substring(0, 500),
              },
            })

            const admins = await prisma.user.findMany({
              where:  { companyId: conn.companyId, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
              select: { id: true },
            })
            const dateInfo = parsed.startDate
              ? ` du ${parsed.startDate}${parsed.endDate ? ` au ${parsed.endDate}` : ""}`
              : ""
            await prisma.notification.createMany({
              data: admins.map((a) => ({
                userId:    a.id,
                companyId: conn.companyId,
                type:      "BOOKING_DETECTED" as const,
                title:     "Réservation Booking.com détectée",
                message:   `${parsed.propertyName ?? "Logement"}${dateInfo} — Cliquez pour affecter une équipe.`,
                link:      "/logements",
              })),
            })
          }

          stats.detected++
        } catch (msgErr) {
          console.error(`[gmail-scan] Error processing message ${msg.id}:`, msgErr)
          stats.errors++
        }
      }
    } catch (connErr) {
      console.error(`[gmail-scan] Error for company ${conn.companyId}:`, connErr)
      stats.errors++
    }
  }

  console.log(`[CRON gmail-scan] scanned: ${stats.scanned}, detected: ${stats.detected}, errors: ${stats.errors}`)
  return NextResponse.json({ ok: true, ...stats })
}
