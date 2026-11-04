import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Card, CardContent } from "@/components/ui/card"
import { OpportunitiesBoard } from "@/components/prospection/OpportunitiesBoard"
import { isProspectionNavVisible, isProspectionWatchEnabled } from "@/lib/prospection/prospection-feature-flag"
import { countOpportunitiesByKind, listOpportunities } from "@/lib/prospection/prospection.repository"
import { parseDepartmentCode, parseStatus, tabForSlug } from "@/lib/prospection/prospection-ui"

export const metadata: Metadata = { title: "Opportunités" }

const LIST_LIMIT = 100

export default async function OpportunitesPage({
  searchParams,
}: {
  searchParams: Promise<{ onglet?: string; dept?: string; statut?: string; masques?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  const { role, companyId } = session.user
  // Garde serveur : SUPER_ADMIN avec une société active. Le menu n'est qu'un affichage.
  if (role !== "SUPER_ADMIN" || !companyId) redirect("/dashboard")

  if (!isProspectionNavVisible({ enabled: isProspectionWatchEnabled(), role, companyId })) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Opportunités</h1>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">La veille prospection est désactivée.</CardContent>
        </Card>
      </div>
    )
  }

  const sp = await searchParams
  const tab = tabForSlug(sp.onglet)
  const departmentCode = parseDepartmentCode(sp.dept)
  const status = parseStatus(sp.statut)
  const includeHidden = sp.masques === "1"

  const [items, counts] = await Promise.all([
    listOpportunities({ companyId, kind: tab.kind, includeHidden, departmentCode, status, limit: LIST_LIMIT }),
    countOpportunitiesByKind(companyId),
  ])

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Opportunités</h1>
        <p className="text-sm text-muted-foreground">
          Veille quotidienne sur des sources publiques (BOAMP, liste des festivals). Chaque piste se qualifie à la main :
          rien n&apos;est envoyé automatiquement.
        </p>
      </div>
      <OpportunitiesBoard
        items={items}
        counts={counts}
        tabSlug={tab.slug}
        filters={{ departmentCode, status, includeHidden }}
        limit={LIST_LIMIT}
      />
    </div>
  )
}
