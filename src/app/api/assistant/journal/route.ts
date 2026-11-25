// Assistant IA, étape 2 : onglet Journal (GET, lecture seule). Deux gardes DISTINCTES, une par source :
// règles locales (garde de /assistant) et assistant IA (copilote de la société + ADMIN/SUPER_ADMIN). Refus si aucune
// source n'est autorisée : 404 si aucun module n'existe pour la société, 401 sans session, sinon 403.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { copilotAdminGuard, rulesSourceGuard } from "@/lib/copilot/copilot-guards"
import { journalDenial, readJournal } from "@/lib/copilot/copilot-tabs"

export const dynamic = "force-dynamic"
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

export async function GET(): Promise<Response> {
  const [rules, copilotAdmin] = await Promise.all([rulesSourceGuard(), copilotAdminGuard()])
  const denial = journalDenial(rules, copilotAdmin)
  if (denial === 404) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (denial) return json({ error: "Accès refusé." }, denial)
  try {
    return json({ rows: await readJournal(prisma, { rules, copilotAdmin }) })
  } catch (error) {
    console.warn("assistant_tab_journal_failed", { code: error instanceof Error ? error.name : "UNKNOWN" })
    return json({ error: "Journal indisponible pour le moment." }, 503)
  }
}
