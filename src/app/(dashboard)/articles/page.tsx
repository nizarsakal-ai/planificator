import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Library, Package } from "lucide-react"
import { ArticleDialog, type ArticleData } from "@/components/articles/ArticleDialog"
import { ArticleDeleteButton } from "@/components/articles/ArticleDeleteButton"

export const metadata: Metadata = { title: "Bibliothèque d'articles" }

const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })

export default async function ArticlesPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const articlesRaw = await prisma.article.findMany({
    where:   { companyId: session.user.companyId!, active: true },
    orderBy: { designation: "asc" },
  })

  // Convertit les Decimal Prisma en number pour les composants client.
  const articles: ArticleData[] = articlesRaw.map((a) => ({
    id:          a.id,
    reference:   a.reference,
    designation: a.designation,
    description: a.description,
    unit:        a.unit,
    unitPrice:   a.unitPrice.toNumber(),
    vatRate:     a.vatRate.toNumber(),
  }))

  return (
    <div className="space-y-6">
      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Library className="h-6 w-6 text-[#0f3460]" />
            Bibliothèque d&apos;articles
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {articles.length} article{articles.length > 1 ? "s" : ""} · catalogue prix pour devis &amp; factures
          </p>
        </div>
        <ArticleDialog />
      </div>

      {/* Liste */}
      {articles.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Package className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucun article pour le moment.</p>
            <p className="text-slate-400 text-sm mt-1">
              Cliquez sur &quot;Nouvel article&quot; pour enrichir votre catalogue.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-slate-500">
                    <th className="px-4 py-3 font-medium">Réf.</th>
                    <th className="px-4 py-3 font-medium">Désignation</th>
                    <th className="px-4 py-3 font-medium">Unité</th>
                    <th className="px-4 py-3 font-medium text-right">Prix HT</th>
                    <th className="px-4 py-3 font-medium text-right">TVA</th>
                    <th className="px-4 py-3 font-medium text-right">Prix TTC</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {articles.map((a) => {
                    const ttc = a.unitPrice * (1 + a.vatRate / 100)
                    return (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-slate-50/60">
                        <td className="px-4 py-3 text-slate-400 font-mono text-xs">{a.reference ?? "—"}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-slate-800">{a.designation}</p>
                          {a.description && <p className="text-xs text-slate-400 mt-0.5">{a.description}</p>}
                        </td>
                        <td className="px-4 py-3 text-slate-500">{a.unit}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{eur.format(a.unitPrice)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-500">{a.vatRate} %</td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-800">{eur.format(ttc)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <ArticleDialog article={a} />
                            <ArticleDeleteButton id={a.id} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
