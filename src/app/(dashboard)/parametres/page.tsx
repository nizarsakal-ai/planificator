import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Building2, SlidersHorizontal, Users, HardHat, CalendarDays } from "lucide-react"
import { CompanyForm } from "@/components/parametres/CompanyForm"
import { SettingsForm } from "@/components/parametres/SettingsForm"
import { GmailConnectionCard } from "@/components/parametres/GmailConnectionCard"
import { AcquisitionGmailConnectionsCard } from "@/components/parametres/AcquisitionGmailConnectionsCard"
import { CompanyLogoCard } from "@/components/parametres/CompanyLogoCard"
import { CompanyIdentityCard } from "@/components/parametres/CompanyIdentityCard"
import { FileBadge } from "lucide-react"
import { getBillingSettings } from "@/lib/billing/settings"
import { assessIssuerIdentity, issuerLegalFooter } from "@/lib/billing/company-identity"
import { isManagedLogo } from "@/lib/company-logo"

export const metadata: Metadata = { title: "Paramètres" }

export default async function ParametresPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; acquisition_gmail?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const company = await prisma.company.findUnique({
    where: { id: session.user.companyId! },
    include: { settings: true },
  })

  if (!company) redirect("/dashboard")

  const { gmail: gmailParam, acquisition_gmail: acquisitionGmailParam } = await searchParams

  // 29/10/2026 — Identité et documents : logo géré + contrôle de complétude de l'identité juridique (devis / factures).
  const billingSettings = await getBillingSettings(prisma, company.id)
  const identityInput = { name: company.name, address: company.address, siret: company.siret, email: company.email, phone: company.phone, settings: billingSettings }
  const identity = assessIssuerIdentity(identityInput)
  const legalFooter = issuerLegalFooter(identityInput)

  // Statistiques rapides + connexions Gmail (Booking vs Acquisition)
  const [nbEmployes, nbEquipes, nbChantiers, gmailConnection, acquisitionGmailConnections] =
    await Promise.all([
      prisma.employee.count({ where: { companyId: company.id, active: true } }),
      prisma.team.count({ where: { companyId: company.id, active: true } }),
      prisma.worksite.count({
        where: { companyId: company.id, status: { in: ["PLANNED", "IN_PROGRESS"] } },
      }),
      prisma.gmailConnection.findUnique({
        where: { companyId: company.id },
        select: { gmailAddress: true, connectedAt: true },
      }),
      prisma.acquisitionGmailConnection.findMany({
        where: { companyId: company.id },
        select: { id: true, gmailAddress: true, tokenExpiry: true, active: true },
        orderBy: { gmailAddress: "asc" },
      }),
    ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Paramètres</h1>
        <p className="text-sm text-slate-500 mt-1">Gérez les informations et réglages de votre entreprise</p>
      </div>

      {/* Stats rapides */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
              <Users className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbEmployes}</p>
              <p className="text-xs text-slate-500">Employés actifs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center">
              <CalendarDays className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbEquipes}</p>
              <p className="text-xs text-slate-500">Équipes actives</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-orange-50 flex items-center justify-center">
              <HardHat className="h-4 w-4 text-orange-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900">{nbChantiers}</p>
              <p className="text-xs text-slate-500">Chantiers en cours</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Infos entreprise */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Building2 className="h-4 w-4" /> Informations de l&apos;entreprise
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CompanyForm company={company} />
          </CardContent>
        </Card>

        {/* Paramètres */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4" /> Réglages
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SettingsForm settings={company.settings} />
          </CardContent>
        </Card>

        {/* Identité et documents (29/10/2026) : logo par entreprise, identité juridique des devis et factures */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <FileBadge className="h-4 w-4" /> Identité et documents
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-slate-500">Logo de l&apos;entreprise</p>
              <CompanyLogoCard companyName={company.name} logoUrl={company.logoUrl} managed={isManagedLogo(company.logoUrl)} />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-slate-500">Identité juridique sur les devis et factures</p>
              <CompanyIdentityCard assessment={identity} legalFooter={legalFooter} />
            </div>
          </CardContent>
        </Card>

        {/* Connexion Gmail Booking (inchangé) */}
        <GmailConnectionCard connection={gmailConnection} gmailParam={gmailParam} />

        {/* Connexions Gmail Acquisition multi-compte */}
        <AcquisitionGmailConnectionsCard
          connections={acquisitionGmailConnections}
          acquisitionGmailParam={acquisitionGmailParam}
        />
      </div>
    </div>
  )
}
