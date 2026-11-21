// 21/11/2026 — création d'un bon de livraison depuis un devis accepté, une facture émise ou un bon de commande client.
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireBillingPage } from "@/lib/billing/access"
import { deliverySourcePreview, type DeliverySourceType } from "@/lib/billing/commercial/delivery-note.service"
import { Card, CardContent } from "@/components/ui/card"
import { DeliveryNoteForm } from "@/components/commercial/CommercialDocumentsUi"

export const metadata: Metadata = { title: "Nouveau bon de livraison" }
const SOURCES: readonly DeliverySourceType[] = ["QUOTE", "INVOICE", "CLIENT_ORDER"]

export default async function NewDeliveryNotePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireBillingPage()
  const sp = await searchParams
  const source = SOURCES.find((s) => s === sp.source)
  const id = typeof sp.id === "string" ? sp.id.slice(0, 64) : ""
  if (!source || !id) notFound()
  const preview = await deliverySourcePreview(prisma, ctx.companyId, source, id)
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-slate-500"><Link href="/bons-de-livraison" className="hover:underline">Bons de livraison</Link> / Nouveau</p>
        <h1 className="text-2xl font-bold text-slate-900">Nouveau bon de livraison{preview.ok ? ` — ${preview.value.label}` : ""}</h1>
      </div>
      {preview.ok
        ? <DeliveryNoteForm sourceType={source} sourceId={id} label={preview.value.label} defaultAddress={preview.value.defaultAddress} lines={preview.value.lines} />
        : <Card className="border-amber-300"><CardContent className="p-4 text-sm text-amber-800">{preview.error}</CardContent></Card>}
    </div>
  )
}
