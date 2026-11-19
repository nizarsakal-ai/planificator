// Lot H Planificator V2 : export CSV des variables de pré-paie. Période clôturée ⇒ instantané figé (refusé en 409 si
// son empreinte ne correspond plus) ; période ouverte ⇒ calcul vivant, fichier marqué PROVISOIRE. Aucun calcul de
// paie. Drapeau PAYROLL_PREP_ENABLED + ADMIN/SUPER_ADMIN ; période d'une autre entreprise ⇒ 404.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { prepayDenialStatus, resolvePrepayAccess } from "@/lib/payroll-prep/access"
import { toCsv } from "@/lib/payroll-prep/prepay.core"
import { getPeriodView } from "@/lib/payroll-prep/queries"

export const dynamic = "force-dynamic"
const ID = /^[A-Za-z0-9_-]{1,64}$/
const none = (status: number) => new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } })

export async function GET(_request: Request, { params }: { params: Promise<{ periodId: string }> }): Promise<Response> {
  const access = await resolvePrepayAccess()
  if (!access.ok) return none(prepayDenialStatus(access.reason))
  const { periodId } = await params
  if (!ID.test(periodId)) return none(404)
  const v = await getPeriodView(prisma, access.context.companyId, periodId)
  if (!v) return none(404)
  if (!v.intact) {
    console.error("[pre-paie] empreinte d'instantané non conforme", v.period.id)
    return none(409)
  }
  const name = `pre-paie-${v.period.year}-${String(v.period.month).padStart(2, "0")}${v.provisional ? "-PROVISOIRE" : ""}.csv`
  return new NextResponse(toCsv(v.lines), {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  })
}
