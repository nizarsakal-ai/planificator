"use client"

import Link from "next/link"
import { CalendarDays, BarChart2 } from "lucide-react"

export function PersonnelViewTabs({
  vue,
  currentDate,
}: {
  vue: "jour" | "plages"
  currentDate: string
}) {
  return (
    <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
      <Link
        href={`/planning/personnel?date=${currentDate}`}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
          vue === "jour"
            ? "bg-white text-[#0f3460] shadow-sm"
            : "text-slate-500 hover:text-slate-700"
        }`}
      >
        <CalendarDays className="h-4 w-4" />
        Vue journée
      </Link>
      <Link
        href={`/planning/personnel?vue=plages`}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
          vue === "plages"
            ? "bg-white text-[#0f3460] shadow-sm"
            : "text-slate-500 hover:text-slate-700"
        }`}
      >
        <BarChart2 className="h-4 w-4" />
        Disponibilités
      </Link>
    </div>
  )
}
