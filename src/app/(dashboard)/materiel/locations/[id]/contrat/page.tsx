// Contrat de location complet, pré-établi et pré-rempli à partir d'un contrat enregistré (lot B, location de matériel).
// Drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN ; un identifiant d'une autre entreprise donne 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { equipmentPageAccess } from "@/lib/equipment/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getRentalContractDocumentData } from "@/lib/equipment/queries"
import { buildRentalContractDocument, BLANK } from "@/lib/equipment/rental-contract-document"
import { logoForPdf } from "@/lib/company-logo"
import { Button } from "@/components/ui/button"
import { ContractDocumentView } from "@/components/equipment/ContractDocumentView"
import { PrintContractButton } from "@/components/equipment/PrintContractButton"
import { StockFlash } from "@/components/stock/StockFlash"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function RentalContractDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await equipmentPageAccess()
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  if (!ID.test(id)) notFound()
  const data = await getRentalContractDocumentData(prisma, ctx.companyId, id)
  if (!data) notFound()
  const doc = buildRentalContractDocument(data)
  const logo = logoForPdf(data.company.logoUrl)
  const sp = await searchParams

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" asChild><Link href={`/materiel/${data.equipment.id}`}><ArrowLeft className="h-4 w-4" /> Fiche {data.equipment.number}</Link></Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><Link href="/materiel/locations">Locations</Link></Button>
          <PrintContractButton />
        </div>
      </div>
      <StockFlash params={sp} />
      <p className="text-xs text-slate-500">Modèle type pré-rempli avec les données du contrat. Les lignes « {BLANK} » sont à compléter à la main. À faire relire par votre conseil si besoin ; les conditions générales du loueur, si elles sont signées, s&apos;appliquent en complément.</p>

      <ContractDocumentView doc={doc} logo={logo} companyName={data.company.name} />
    </div>
  )
}
