"use client"

import { useRouter } from "next/navigation"

export function MonthPicker({ value }: { value: string }) {
  const router = useRouter()

  return (
    <input
      type="month"
      value={value}
      max={new Date().toISOString().slice(0, 7)}
      onChange={(e) => {
        if (e.target.value) router.push(`/rapports/mensuel?mois=${e.target.value}`)
      }}
      className="text-sm border border-slate-200 rounded-lg px-3 py-2 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
    />
  )
}
