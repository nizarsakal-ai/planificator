// Lot C Planificator V2 : export CSV des marges (tous les chantiers, ou un seul avec ?chantier=). Même format que les
// exports comptables (séparateur « ; », virgule décimale, BOM, cellules texte neutralisées contre les formules).
// Drapeau WORKSITE_BUDGET_ENABLED + ADMIN/SUPER_ADMIN ; désactivé ⇒ 404 ; chantier d'une autre entreprise ⇒ 404.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { budgetDenialStatus, resolveBudgetAccess } from "@/lib/budget/access"
import { COST_NATURES, COST_NATURE_LABEL, type WorksiteMargin } from "@/lib/budget/budget.core"
import { getWorksiteBudget, listWorksiteMargins, MAX_WORKSITES } from "@/lib/budget/queries"
import { buildCsv, csvFilename, type CsvCell } from "@/lib/accounting/ui/csv"
import { csvResponse } from "@/lib/accounting/ui/route-guard"
import { serverNow } from "@/lib/billing/clock"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })
const bp = (v: number | null): CsvCell => ({ raw: v === null ? "" : (v / 100).toFixed(2).replace(".", ",") })

const HEADER = [
  "Chantier", "Client", "Archivé", "Version du budget", "Recette prévue", "Coût prévu", "Marge prévue", "Taux de marge prévue (%)",
  "Devis signés", "Facturé", "Engagé", "Réel", "Marge à date", "Taux de marge à date (%)", "Marge estimée", "Taux de marge estimée (%)",
  ...COST_NATURES.flatMap((n) => [`${COST_NATURE_LABEL[n]} prévu`, `${COST_NATURE_LABEL[n]} engagé`, `${COST_NATURE_LABEL[n]} réel`]),
  "Points à vérifier",
]
function row(r: WorksiteMargin & { name: string; clientName: string; archived: boolean }): CsvCell[] {
  return [
    { text: r.name }, { text: r.clientName }, { text: r.archived ? "oui" : "non" }, { raw: r.budgetRevision === null ? "" : String(r.budgetRevision) },
    { amount: r.plannedRevenueCents }, { amount: r.plannedCostCents }, { amount: r.plannedMarginCents }, bp(r.plannedMarginBp),
    { amount: r.signedQuotesHTCents }, { amount: r.invoicedHTCents }, { amount: r.committedCents }, { amount: r.actualCents },
    { amount: r.currentMarginCents }, bp(r.currentMarginBp), { amount: r.forecastMarginCents }, bp(r.forecastMarginBp),
    ...r.natures.flatMap((n): CsvCell[] => [{ amount: n.plannedCents }, { amount: n.committedCents }, { amount: n.actualCents }]),
    { text: r.anomalies.map((a) => a.message).join(" | ") },
  ]
}

export async function GET(request: Request): Promise<Response> {
  const access = await resolveBudgetAccess()
  if (!access.ok) return none(budgetDenialStatus(access.reason))
  const companyId = access.context.companyId
  const params = new URL(request.url).searchParams
  const day = serverNow().toISOString().slice(0, 10)
  const one = params.get("chantier")
  if (one !== null) {
    if (!ID.test(one)) return none(404)
    const data = await getWorksiteBudget(prisma, companyId, one)
    if (!data) return none(404)
    const csv = buildCsv(HEADER, [row({ name: data.worksite.name, clientName: data.worksite.clientName, archived: data.worksite.archived, ...data.margin })])
    return csvResponse(csv, csvFilename(`marge-${data.worksite.name}-${day}`))
  }
  const { rows, truncated } = await listWorksiteMargins(prisma, companyId, { includeArchived: params.get("archives") === "1" })
  // Revue indépendante : une troncature n'est jamais silencieuse (dernière ligne explicite).
  const body = rows.map(row)
  if (truncated) body.push([{ text: `EXPORT INCOMPLET : limité aux ${MAX_WORKSITES} premiers chantiers (ordre alphabétique)` }])
  return csvResponse(buildCsv(HEADER, body), csvFilename(`marges-chantiers-${day}`))
}
