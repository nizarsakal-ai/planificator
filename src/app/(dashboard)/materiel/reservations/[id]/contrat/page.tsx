// Contrat client établi automatiquement pour chaque réservation : la société loue son matériel au client de l'événement.
// Drapeau EQUIPMENT_RENTAL_ENABLED + ADMIN/SUPER_ADMIN ; un identifiant d'une autre entreprise donne 404.
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { prisma } from "@/lib/prisma"
import { equipmentPageAccess } from "@/lib/equipment/access"
import { AdminOnlyNotice } from "@/components/stock/AdminOnlyNotice"
import { getBookingContractDocumentData } from "@/lib/equipment/queries"
import { buildBookingContractDocument, BLANK } from "@/lib/equipment/rental-contract-document"
import { logoForPdf } from "@/lib/company-logo"
import { Button } from "@/components/ui/button"
import { ContractDocumentView } from "@/components/equipment/ContractDocumentView"
import { PrintContractButton } from "@/components/equipment/PrintContractButton"
import { StockFlash } from "@/components/stock/StockFlash"

const ID = /^[A-Za-z0-9_-]{1,64}$/

export default async function BookingContractDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await equipmentPageAccess()
  if (!ctx) return <AdminOnlyNotice />
  const { id } = await params
  if (!ID.test(id)) notFound()
  const data = await getBookingContractDocumentData(prisma, ctx.companyId, id)
  if (!data) notFound()
  const doc = buildBookingContractDocument(data)
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
      <p className="text-xs text-slate-500">Contrat établi automatiquement à partir de la réservation (période, matériel, client du chantier). Les lignes « {BLANK} » sont à compléter à la main. Rattachez la réservation à un chantier pour reprendre automatiquement le client ; indiquez le n° du devis accepté.</p>

      <ContractDocumentView doc={doc} logo={logo} companyName={data.company.name} />
    </div>
  )
}
