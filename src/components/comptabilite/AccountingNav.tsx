"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { ACCOUNTING_TABS, activeAccountingTab } from "@/lib/accounting/ui/accounting-nav"

// Cinq onglets (Achats, Ventes, Devis, Banque, Plus) : les écrans experts sont regroupés sous « Plus ».
export function AccountingNav() {
  const active = activeAccountingTab(usePathname())
  return (
    <nav aria-label="Comptabilité" className="flex flex-wrap items-center gap-1 border-b border-slate-200 pb-2">
      {ACCOUNTING_TABS.map((item) => (
        <Link key={item.href} href={item.href} aria-current={item.href === active ? "page" : undefined}
          className={cn("rounded-md px-3 py-1.5 text-sm font-medium", item.href === active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100")}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
