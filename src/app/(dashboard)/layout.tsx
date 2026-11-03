import { resolveHrDocumentNavigation } from "@/lib/hr-documents/navigation"
import { resolveSupplierIntakeAccess } from "@/lib/supplier-intake/access"
import { CompanyBrand } from "@/components/company/CompanyBrand"
import { prisma } from "@/lib/prisma"
import { logoForPdf } from "@/lib/company-logo"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/layout/Sidebar"
import { Navbar } from "@/components/layout/Navbar"
import { InstallPrompt } from "@/components/pwa/InstallPrompt"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { isAccountingNavVisible } from "@/lib/accounting/access/accounting-access.core"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { isWorksitePhotosEnabled } from "@/lib/worksite-photos/feature-flag"
import type { Role } from "@prisma/client"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user) redirect("/login")

  const role = session.user.role as Role
  const companyId = session.user.companyId
  // Les clients ont leur propre portail
  if (role === "CLIENT") redirect("/mes-chantiers")

  // Rôle et société ACTIFS issus de la session (résolus par l'appartenance multi-société dans le callback JWT)
  // Lien « Comptabilité » : affichage seulement (flag lu côté serveur) ; la page applique sa propre garde.
  const accountingNavVisible = isAccountingNavVisible({
    enabled: isAccountingModuleEnabled(),
    role,
    companyId,
  })
  // Lien « Devis » (Lot C) : drapeau serveur + rôle ADMIN/SUPER_ADMIN + société ; affichage seulement.
  const billingNavVisible = isBillingCompleteEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const supplierIntakeNavVisible = !!(await resolveSupplierIntakeAccess())
  // Photos d'engins (SPEC-WORKSITE-PHOTOS-001) : drapeau serveur + rôle interne + société ; affichage seulement.
  const worksitePhotosNavVisible = isWorksitePhotosEnabled() && ["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"].includes(role) && !!companyId
  const company = companyId ? await prisma.company.findUnique({
    where: { id: companyId }, select: { name: true, logoUrl: true },
  }) : null
  const companyLogo = logoForPdf(company?.logoUrl)
  const hrNavigation = await resolveHrDocumentNavigation()
  const user = { ...hrNavigation, ...session.user, role, companyId, accountingNavVisible, billingNavVisible, supplierIntakeNavVisible, worksitePhotosNavVisible, companyLogo, companyName: company?.name }

  return (
    <div data-app-backdrop="" className="flex h-screen overflow-hidden bg-[#f6f1e7] bg-[radial-gradient(45%_55%_at_4%_0%,rgba(120,160,255,0.65)_0,transparent_70%),radial-gradient(40%_45%_at_100%_100%,rgba(70,120,250,0.45)_0,transparent_70%),radial-gradient(28%_34%_at_100%_8%,rgba(140,175,255,0.4)_0,transparent_70%),radial-gradient(30%_36%_at_55%_45%,rgba(255,250,240,0.85)_0,transparent_70%)]">
      <Sidebar user={user} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Navbar user={user} />
        <main data-app-shell="" className="flex-1 overflow-y-auto p-4 md:p-6">
          {company && <CompanyBrand name={company.name} logo={companyLogo} />}
          {children}
        </main>
      </div>
      <InstallPrompt />
    </div>
  )
}
