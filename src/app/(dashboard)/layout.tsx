import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/layout/Sidebar"
import { Navbar } from "@/components/layout/Navbar"
import { InstallPrompt } from "@/components/pwa/InstallPrompt"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { isAccountingNavVisible } from "@/lib/accounting/access/accounting-access.core"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
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
  const user = { ...session.user, role, companyId, accountingNavVisible, billingNavVisible }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar user={user} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Navbar user={user} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
      <InstallPrompt />
    </div>
  )
}
