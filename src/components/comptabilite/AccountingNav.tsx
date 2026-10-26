"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { UPCOMING_MODULES } from "@/lib/accounting/ui/labels"

const ITEMS = [
  { href: "/comptabilite", label: "Accueil", exact: true },
  { href: "/comptabilite/ecritures", label: "Écritures" },
  { href: "/comptabilite/balance", label: "Balance" },
  { href: "/comptabilite/grand-livre", label: "Grand livre" },
  { href: "/comptabilite/plan", label: "Plan comptable" },
  { href: "/comptabilite/exercices", label: "Exercices" },
  // Lot C5 (SPEC-BILLING-C5) : modules annoncés « à venir » par A2, désormais livrés.
  { href: "/comptabilite/tableau-de-bord", label: "Tableau de bord" },
  { href: "/comptabilite/factures", label: "Écritures depuis les factures" },
  { href: "/comptabilite/tva", label: "TVA" },
  { href: "/comptabilite/fec", label: "Export FEC" },
  { href: "/comptabilite/banque", label: "Banque et rapprochement" },
  { href: "/comptabilite/fournisseurs", label: "Factures fournisseurs" },
]
// Place réservée aux modules suivants (SPEC-ACC-A2 §6) : liste vide depuis le Lot C5.

export function AccountingNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Comptabilité" className="flex flex-wrap items-center gap-1 border-b border-slate-200 pb-2">
      {ITEMS.map((item) => {
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm font-medium", active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100")}>
            {item.label}
          </Link>
        )
      })}
      <span className="mx-2 hidden h-5 w-px bg-slate-200 sm:inline-block" aria-hidden />
      {UPCOMING_MODULES.map((label) => (
        <span key={label} aria-disabled="true" title="Module à venir" className="cursor-not-allowed rounded-md px-3 py-1.5 text-sm text-slate-400">
          {label} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">à venir</span>
        </span>
      ))}
    </nav>
  )
}
