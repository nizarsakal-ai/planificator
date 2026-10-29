import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { ProfilForm } from "@/components/profil/ProfilForm"

import { CompanyLogoCard } from "@/components/parametres/CompanyLogoCard"
import { isManagedLogo } from "@/lib/company-logo"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata: Metadata = { title: "Mon profil" }

export default async function ProfilPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, role: true, companyId: true },
  })

  if (!user) redirect("/login")

  const canManageLogo = ["ADMIN", "SUPER_ADMIN"].includes(session.user.role)
  const company = canManageLogo && session.user.companyId
    ? await prisma.company.findUnique({
        where: { id: session.user.companyId },
        select: { id: true, name: true, logoUrl: true },
      })
    : null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Mon profil</h1>
        <p className="text-sm text-slate-500 mt-1">Gérez vos informations personnelles et votre mot de passe</p>
      </div>

      <ProfilForm user={user} />

      {company && (
        <Card>
          <CardHeader>
            <CardTitle>Logo de la société — {company.name}</CardTitle>
            <p className="text-sm text-slate-500">Importez votre fichier pour les devis et factures de cette société.</p>
          </CardHeader>
          <CardContent>
            <CompanyLogoCard key={company.id} companyName={company.name} logoUrl={company.logoUrl} managed={isManagedLogo(company.logoUrl)} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
