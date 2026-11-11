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

      <article data-print-document="" className="mx-auto max-w-[210mm] rounded-lg border border-slate-200 bg-white px-8 py-10 text-[13px] leading-relaxed text-slate-800 print:max-w-none print:rounded-none print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-6 border-b border-slate-300 pb-4">
          <div>
            <h1 className="text-xl font-bold uppercase tracking-wide text-slate-900">{doc.title}</h1>
            <p className="mt-1 text-slate-600">{doc.reference}</p>
            {doc.statusNote && <p className="mt-2 inline-block rounded border border-red-300 px-2 py-0.5 text-xs font-semibold uppercase text-red-700">{doc.statusNote}</p>}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logo && <img src={logo} alt={data.company.name} className="max-h-16 max-w-[160px] object-contain" />}
        </header>

        <section className="mt-6">
          <h2 className="text-sm font-bold uppercase text-slate-900">Entre les soussignés</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 print:grid-cols-2">
            {[doc.lessor, doc.lessee].map((p) => (
              <div key={p.role} className="rounded border border-slate-300 p-3">
                <p className="text-xs font-semibold uppercase text-slate-500">{p.role}</p>
                <p className="mt-1 font-semibold text-slate-900">{p.name}</p>
                {p.lines.map((l) => <p key={l} className="text-slate-700">{l}</p>)}
              </div>
            ))}
          </div>
          <p className="mt-3">Il a été convenu ce qui suit.</p>
        </section>

        <section className="mt-6 break-inside-avoid">
          <h2 className="text-sm font-bold uppercase text-slate-900">Conditions particulières</h2>
          <table className="mt-2 w-full border-collapse">
            <tbody>
              {doc.particular.map((r) => (
                <tr key={r.label} className="border-b border-slate-200">
                  <th className="w-1/2 py-1.5 pr-3 text-left align-top font-medium text-slate-600">{r.label}</th>
                  <td className="py-1.5 tabular-nums text-slate-900">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-6">
          <h2 className="text-sm font-bold uppercase text-slate-900">Conditions générales de location</h2>
          {doc.articles.map((a, i) => (
            <div key={a.title} className="mt-3 break-inside-avoid">
              <h3 className="font-semibold text-slate-900">Article {i + 1} · {a.title}</h3>
              {a.paragraphs.map((p, j) => <p key={j} className="mt-1 whitespace-pre-line text-justify">{p}</p>)}
            </div>
          ))}
        </section>

        <section className="mt-8 break-inside-avoid">
          <p>Fait en deux exemplaires originaux, à {BLANK}, le {BLANK}.</p>
          <div className="mt-4 grid grid-cols-2 gap-6">
            {[doc.lessor, doc.lessee].map((p) => (
              <div key={p.role} className="h-36 rounded border border-slate-300 p-3">
                <p className="font-semibold text-slate-900">{p.role} · {p.name}</p>
                <p className="text-xs text-slate-500">Nom, qualité, cachet et signature, précédés de la mention « Lu et approuvé »</p>
              </div>
            ))}
          </div>
        </section>
      </article>
    </div>
  )
}
