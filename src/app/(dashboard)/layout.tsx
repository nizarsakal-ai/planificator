import { resolveHrDocumentNavigation } from "@/lib/hr-documents/navigation"
import { resolveSupplierIntakeAccess } from "@/lib/supplier-intake/access"
import { CompanyBrand } from "@/components/company/CompanyBrand"
import { prisma } from "@/lib/prisma"
import { companyLogoDisplaySrc } from "@/lib/company-logo"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/layout/Sidebar"
import { Navbar } from "@/components/layout/Navbar"
import { InstallPrompt } from "@/components/pwa/InstallPrompt"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { isAccountingNavVisible } from "@/lib/accounting/access/accounting-access.core"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { isWorksitePhotosEnabled } from "@/lib/worksite-photos/feature-flag"
import { isProspectionNavVisible, isProspectionWatchEnabled } from "@/lib/prospection/prospection-feature-flag"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"
import { isWorksiteBudgetEnabled } from "@/lib/budget/budget-feature-flag"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { isAssistantEnabledForCompany } from "@/lib/assistant/assistant-feature-flag"
import { isConnectorCenterEnabledForCompany } from "@/lib/connectors/connector-feature-flag"
import { isDocumentStudioEnabled } from "@/lib/document-studio/studio-feature-flag"
import { isPayrollPrepEnabledForCompany } from "@/lib/payroll-prep/prepay-feature-flag"
import { isMarketingShopEnabledForCompany } from "@/lib/marketing-shop/marketing-shop-feature-flag"
import { isWorksiteReservesEnabled } from "@/lib/reserves/reserves-feature-flag"
import { isSalesDashboardEnabled } from "@/lib/sales-dashboard/sales-feature-flag"
import { isGlobalSearchEnabled } from "@/lib/search/search-feature-flag"
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
  // Opportunités (veille prospection V1) : drapeau serveur + SUPER_ADMIN + société ; affichage seulement.
  const prospectionNavVisible = isProspectionNavVisible({ enabled: isProspectionWatchEnabled(), role, companyId })
  // Stocks et achats (Lot A V2) : drapeau serveur + rôle ADMIN/SUPER_ADMIN + société ; affichage seulement.
  const stockPurchasingNavVisible = isStockPurchasingEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  // Matériel et location (Lot B V2) : même règle d'affichage, drapeau distinct.
  const budgetNavVisible = isWorksiteBudgetEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const equipmentNavVisible = isEquipmentRentalEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  // Ticket carburant : chauffeur attitré d'un camion actif de la société ; affichage seulement.
  const fuelTicketNavVisible = isVehiclesV3Enabled() && !!companyId && ["EMPLOYEE", "TEAM_LEADER", "ADMIN", "SUPER_ADMIN"].includes(role)
    && (await prisma.truck.count({ where: { companyId, active: true, archivedAt: null, chauffeur: { userId: session.user.id, companyId, active: true } } }).catch(() => 0)) > 0
  // Lot E V2 : opportunités CRM et automatisations ; même règle d'affichage, drapeaux distincts.
  const crmNavVisible = isCrmEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const automationNavVisible = isAutomationsEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  // Lot F V2 : assistant et centre de connecteurs ; société active exactement égale à la cible de chaque module (même
  // lecture que sa garde, côté serveur seulement) ; rôle ADMIN/SUPER_ADMIN. Affichage seulement : pages et actions refusent.
  const assistantNavVisible = isAssistantEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")
  const connectorsNavVisible = isConnectorCenterEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")
  // Lot G V2 : Document Studio ; même règle d'affichage, drapeau distinct.
  const documentStudioNavVisible = isDocumentStudioEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  // Lot H V2 : pré-paie ; drapeau strict ET société active exactement égale à la société pilote (configuration serveur
  // partagée avec la garde H) ; rôle ADMIN/SUPER_ADMIN. Affichage seulement : pages, actions et export refusent côté serveur.
  const payrollPrepNavVisible = isPayrollPrepEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")
  // Lot I V2 : marketing et boutique ; société active exactement égale à la société pilote d'un module activé (même cible
  // que la garde I, lue côté serveur seulement) ; rôle ADMIN/SUPER_ADMIN. Affichage seulement : pages et actions refusent.
  const marketingShopNavVisible = isMarketingShopEnabledForCompany(companyId) && (role === "ADMIN" || role === "SUPER_ADMIN")
  // Lot D V2 : réserves, indicateurs commerciaux et recherche globale ; même règle d'affichage, drapeaux distincts (désactivés par défaut).
  const reservesNavVisible = isWorksiteReservesEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const salesDashboardNavVisible = isSalesDashboardEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const searchVisible = isGlobalSearchEnabled() && (role === "ADMIN" || role === "SUPER_ADMIN") && !!companyId
  const company = companyId ? await prisma.company.findUnique({
    where: { id: companyId }, select: { name: true, logoUrl: true },
  }) : null
  // Correctif #418 : adresse courte d'affichage, jamais la data URL dans la charge RSC de la coquille (voir companyLogoDisplaySrc).
  const companyLogo = companyLogoDisplaySrc(company?.logoUrl)
  const hrNavigation = await resolveHrDocumentNavigation()
  const user = { ...hrNavigation, ...session.user, role, companyId, accountingNavVisible, billingNavVisible, supplierIntakeNavVisible, worksitePhotosNavVisible, prospectionNavVisible, stockPurchasingNavVisible, equipmentNavVisible, budgetNavVisible, fuelTicketNavVisible, companyLogo, companyName: company?.name, documentStudioNavVisible, payrollPrepNavVisible, marketingShopNavVisible, crmNavVisible, automationNavVisible, assistantNavVisible, connectorsNavVisible, reservesNavVisible, salesDashboardNavVisible, searchVisible }

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
