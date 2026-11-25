import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  BAT_STATUS_LABELS,
  PRODUCTION_STATUS_LABELS,
  readPrintManagerQuote,
} from "@/lib/imprimerie/print-manager"
import { imprimerieProductionDossier, PRINT_MANAGER_STUDIO_URL } from "@/lib/imprimerie/production"
import { prisma } from "@/lib/prisma"
import { BUSINESS_TIMEZONE } from "@/lib/time/business-day"

export const metadata: Metadata = { title: "Imprimerie" }

const deliveryDate = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeZone: BUSINESS_TIMEZONE,
})

const quoteMessages = {
  missing: "Le devis associé est introuvable dans Print Manager.",
  unavailable: "Le suivi Print Manager est temporairement indisponible.",
}

const quoteStatuses: Record<string, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyé",
  ACCEPTED: "Accepté",
  REFUSED: "Refusé",
  EXPIRED: "Expiré",
  CONVERTED: "Facturé",
}

export default async function ImprimeriePage() {
  const session = await auth()
  const dossier = session?.user && imprimerieProductionDossier(session.user)
  if (!dossier) notFound()

  const chantier = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`
    return tx.worksite.findFirst({
      where: { id: dossier.worksiteId, companyId: dossier.companyId, company: { active: true } },
      select: { name: true },
    })
  })
  const result = chantier
    ? await readPrintManagerQuote(dossier.quoteNumber, (await headers()).get("x-vercel-oidc-token") ?? process.env.VERCEL_OIDC_TOKEN)
    : undefined
  const quote = result?.state === "ready" ? result.quote : undefined
  const bat = quote?.bat
  const productionOrders = quote?.productionOrders
  const deliveryOrders = productionOrders?.filter(({ status }) => status !== "ANNULE")
  const deliveredOrders = deliveryOrders?.filter(({ status }) => status === "LIVRE") ?? []

  let message: string | undefined
  if (!chantier) message = "Le chantier associé est introuvable."
  else if (result && result.state !== "ready") message = quoteMessages[result.state]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Imprimerie</h1>
        <Button asChild variant="outline">
          <a href={PRINT_MANAGER_STUDIO_URL}>Ouvrir le Studio Graphique</a>
        </Button>
      </div>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle>Devis Print Manager associé</CardTitle>
          <Badge variant="outline">Lecture seule</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {chantier && (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-slate-600">Chantier</dt>
                <dd className="mt-1 font-medium text-slate-900">{chantier.name}</dd>
              </div>
              {quote && (
                <>
                  <div>
                    <dt className="text-sm text-slate-600">Devis</dt>
                    <dd className="mt-1 font-medium text-slate-900">{quote.number}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-slate-600">Statut du devis</dt>
                    <dd className="mt-1">{quoteStatuses[quote.status] ?? quote.status}</dd>
                  </div>
                  <div className="border-t border-slate-200 pt-4 sm:col-span-3">
                    <dt className="text-sm text-slate-600">Bon à tirer</dt>
                    <dd className="mt-1 flex flex-wrap items-center gap-2">
                      {bat ? (
                        <>
                          <span className="font-medium text-slate-900">{bat.number}</span>
                          <Badge variant="outline">{BAT_STATUS_LABELS[bat.status]}</Badge>
                        </>
                      ) : bat === null ? "Aucun BAT lié à ce devis." : "Statut du BAT indisponible."}
                    </dd>
                  </div>
                  <div className="border-t border-slate-200 pt-4 sm:col-span-3">
                    <dt className="text-sm text-slate-600">Fabrication</dt>
                    <dd className="mt-1">
                      {productionOrders?.length ? (
                        <ul className="space-y-2">
                          {productionOrders.map(({ number, status }) => (
                            <li key={number} className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-slate-900">{number}</span>
                              <Badge variant="outline">{PRODUCTION_STATUS_LABELS[status]}</Badge>
                            </li>
                          ))}
                        </ul>
                      ) : productionOrders
                        ? "Aucun ordre de fabrication lié à ce devis."
                        : "Suivi de fabrication indisponible."}
                    </dd>
                  </div>
                  <div className="border-t border-slate-200 pt-4 sm:col-span-3">
                    <dt className="text-sm text-slate-600">Livraison</dt>
                    <dd className="mt-1 space-y-2">
                      {deliveryOrders?.length ? (
                        <>
                          <div className="flex flex-wrap items-center gap-2">
                            Ordres livrés
                            <Badge variant="outline">{deliveredOrders.length} sur {deliveryOrders.length}</Badge>
                          </div>
                          {deliveredOrders.length > 0 && (
                            <ul className="space-y-2">
                              {deliveredOrders.map(({ number, deliveredAt }) => (
                                <li key={number} className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium text-slate-900">{number}</span>
                                  {deliveredAt ? (
                                    <span>
                                      Livré le <time dateTime={deliveredAt}>{deliveryDate.format(new Date(deliveredAt))}</time>
                                    </span>
                                  ) : <span>Livré · date non renseignée</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : deliveryOrders
                        ? "Aucun ordre à livrer."
                        : "Suivi de livraison indisponible."}
                    </dd>
                  </div>
                </>
              )}
            </dl>
          )}
          {message && <p className="text-sm text-slate-700">{message}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
