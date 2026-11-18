import type { Metadata } from "next"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { requireAccountingPage } from "@/lib/accounting/ui/page-context"
import { PLUS_SECTIONS } from "@/lib/accounting/ui/accounting-nav"
import { Card, CardContent } from "@/components/ui/card"

export const metadata: Metadata = { title: "Comptabilité — Plus" }

// Écran « Plus » : tous les écrans du module qui ne sont pas un onglet, regroupés par usage. Aucune donnée lue.
export default async function PlusPage() {
  await requireAccountingPage()
  return (
    <div className="space-y-6">
      {PLUS_SECTIONS.map((section) => (
        <section key={section.title} className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">{section.title}</h2>
          <Card><CardContent className="p-0">
            <ul className="divide-y">
              {section.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <span><span className="block text-sm font-medium text-slate-900">{link.label}</span><span className="block text-xs text-slate-500">{link.hint}</span></span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent></Card>
        </section>
      ))}
    </div>
  )
}
