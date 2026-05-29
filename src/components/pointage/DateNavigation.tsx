"use client"

import { useRouter } from "next/navigation"

interface Props {
  selectedDate: string // ISO "YYYY-MM-DD"
  prevDate: string
  nextDate: string
  isToday: boolean
}

export function DateNavigation({ selectedDate, prevDate, nextDate, isToday }: Props) {
  const router = useRouter()

  return (
    <div className="flex items-center gap-2">
      <a
        href={`/pointages?date=${prevDate}`}
        className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
      >
        ← Précédent
      </a>
      <input
        type="date"
        defaultValue={selectedDate}
        onChange={(e) => {
          if (e.target.value) router.push(`/pointages?date=${e.target.value}`)
        }}
        className="h-9 rounded-lg border border-slate-200 px-3 text-sm"
      />
      {!isToday && (
        <a
          href={`/pointages?date=${nextDate}`}
          className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
        >
          Suivant →
        </a>
      )}
    </div>
  )
}
