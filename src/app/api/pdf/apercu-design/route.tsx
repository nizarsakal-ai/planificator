// 20/11/2026 — aperçu PDF d'un design (modèle, couleurs, format, options) sur un document d'exemple. Lecture seule.
import { NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { prisma } from "@/lib/prisma"
import { requireBillingRoute } from "@/lib/billing/access"
import { getBillingSettings } from "@/lib/billing/settings"
import { issuerLegalFooter } from "@/lib/billing/company-identity"
import { logoForPdf } from "@/lib/company-logo"
import { sellerParty } from "@/lib/billing/pdf/document-data"
import { validateDesign } from "@/lib/billing/pdf/design"
import { buildDesignPreviewData } from "@/lib/billing/pdf/design-preview"
import { DocumentPdf } from "@/lib/billing/pdf/DocumentPdf"

export const dynamic = "force-dynamic"

const text = (status: number, body: string) => new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } })

export async function GET(req: Request) {
  const access = await requireBillingRoute()
  if (!access.ok) return access.response
  const q = new URL(req.url).searchParams
  const v = validateDesign({
    template: q.get("template") ?? "", primary: q.get("primary") ?? "", secondary: q.get("secondary") ?? "",
    layout: q.get("layout") ?? "COMPLETE", showClientIds: q.get("clientIds") !== "0", showBankDetails: q.get("bank") === "1",
  })
  if (!v.ok) return text(400, v.errors.join("\n"))
  const [company, settings] = await Promise.all([
    prisma.company.findUnique({ where: { id: access.ctx.companyId }, select: { name: true, address: true, siret: true, email: true, phone: true, logoUrl: true } }),
    getBillingSettings(prisma, access.ctx.companyId),
  ])
  if (!company) return new NextResponse(null, { status: 404 })
  const data = buildDesignPreviewData(v.design, {
    seller: sellerParty(company, settings),
    logoDataUrl: logoForPdf(company.logoUrl),
    legalFooter: issuerLegalFooter({ name: company.name, address: company.address, siret: company.siret, email: company.email, phone: company.phone, settings }),
    bank: settings.iban ? { iban: settings.iban, bic: settings.bic } : null,
  })
  const buffer = await renderToBuffer(<DocumentPdf data={data} />)
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="apercu-${v.design.template.toLowerCase()}.pdf"`, "Cache-Control": "no-store" } })
}
