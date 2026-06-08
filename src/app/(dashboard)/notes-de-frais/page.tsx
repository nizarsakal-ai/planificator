import type { Metadata } from "next"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Card, CardContent } from "@/components/ui/card"
import { Receipt } from "lucide-react"
import Image from "next/image"
import { ExpenseActions } from "@/components/expenses/ExpenseActions"

export const metadata: Metadata = { title: "Notes de frais" }

const CATEGORY_LABELS: Record<string, string> = {
  TRANSPORT:   "Transport",
  REPAS:       "Repas",
  HEBERGEMENT: "Hébergement",
  MATERIEL:    "Matériel",
  OTHER:       "Autre",
}
const STATUS_STYLE: Record<string, string> = {
  PENDING:  "bg-amber-100 text-amber-700",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
}
function fmt(d: Date | string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d))
}

export default async function NotesDeFraisPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"].includes(session.user.role)) redirect("/dashboard")

  const expenses = await prisma.expenseReport.findMany({
    where: { companyId: session.user.companyId! },
    include: { employee: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: "desc" },
  })

  const pending  = expenses.filter((e) => e.status === "PENDING").length
  const approved = expenses.filter((e) => e.status === "APPROVED").reduce((s, e) => s + e.amount, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Notes de frais</h1>
        <p className="text-sm text-slate-500 mt-1">
          {pending > 0 ? `${pending} en attente · ` : ""}{approved.toFixed(2)} € approuvés
        </p>
      </div>

      {expenses.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Receipt className="h-10 w-10 text-slate-200 mx-auto mb-3" />
            <p className="text-slate-400 font-medium">Aucune note de frais pour le moment.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y divide-slate-50">
            {expenses.map((e) => (
              <div key={e.id} className="flex items-start gap-3 px-4 py-3">
                {e.receiptUrl && (
                  <a href={e.receiptUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    <Image
                      src={e.receiptUrl}
                      alt="Justificatif"
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded-lg object-cover border border-slate-200 hover:opacity-80 transition-opacity"
                      unoptimized
                    />
                  </a>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-slate-800">{e.amount.toFixed(2)} €</p>
                    <span className="text-xs font-medium text-slate-600">{e.employee.firstName} {e.employee.lastName}</span>
                    <span className="text-xs text-slate-400">{CATEGORY_LABELS[e.category]}</span>
                    <span className="text-xs text-slate-300">·</span>
                    <span className="text-xs text-slate-400">{fmt(e.date)}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{e.description}</p>
                  {e.rejectionNote && (
                    <p className="text-xs text-red-500 mt-0.5">Refus : {e.rejectionNote}</p>
                  )}
                </div>
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ${STATUS_STYLE[e.status]}`}>
                  {e.status === "APPROVED" ? "Approuvée" : e.status === "REJECTED" ? "Refusée" : "En attente"}
                </span>
                <ExpenseActions
                  id={e.id}
                  status={e.status}
                  isAdmin={true}
                  isOwner={false}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
