import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertCircle, XCircle, Users } from "lucide-react"
import Link from "next/link"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FreeWindow {
  from: string  // "YYYY-MM-DD"
  to: string
  days: number
}

export interface TimelineSegment {
  occupied: boolean
  count: number
}

export interface EmployeeAvailability {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  team: { name: string; color: string | null } | null
  freeWindows: FreeWindow[]
  timeline: TimelineSegment[]
  totalFreeDays: number
  totalDays: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FMT_SHORT = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long" })
const FMT_FULL  = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" })

function fmtDate(s: string) {
  return FMT_SHORT.format(new Date(s + "T00:00:00"))
}

function fmtRange(from: string, to: string) {
  const f = new Date(from + "T00:00:00")
  const t = new Date(to   + "T00:00:00")
  if (from === to) return FMT_FULL.format(f)
  // same month → "6 au 28 juin"
  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    return `${f.getDate()} au ${FMT_FULL.format(t)}`
  }
  return `${fmtDate(from)} au ${fmtDate(to)}`
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PersonnelDisponibiliteView({
  employees,
  fromDate,
  toDate,
  horizon,
}: {
  employees: EmployeeAvailability[]
  fromDate: string
  toDate: string
  horizon: number
}) {
  if (employees.length === 0) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <Users className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Aucun employé actif.</p>
        </CardContent>
      </Card>
    )
  }

  const fullyFree     = employees.filter((e) => e.totalFreeDays === e.totalDays)
  const partial       = employees.filter((e) => e.totalFreeDays > 0 && e.totalFreeDays < e.totalDays)
  const fullyOccupied = employees.filter((e) => e.totalFreeDays === 0)

  // Sort partial by most available first
  partial.sort((a, b) => b.totalFreeDays - a.totalFreeDays)

  const periodLabel = `${fmtDate(fromDate)} → ${fmtDate(toDate)}`

  return (
    <div className="space-y-6">
      {/* Period + horizon selector */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-slate-500">
          Période analysée : <span className="font-medium text-slate-700">{periodLabel}</span>
          <span className="ml-2 text-slate-400">({horizon} jours)</span>
        </p>
        <div className="flex items-center gap-1">
          {[30, 60, 90].map((d) => (
            <Link
              key={d}
              href={`/planning/personnel?vue=plages&days=${d}`}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                horizon === d
                  ? "bg-[#0f3460] text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {d}j
            </Link>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="border-0 bg-emerald-50">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-emerald-700">{fullyFree.length}</p>
            <p className="text-xs text-emerald-600 mt-0.5">Entièrement libres</p>
          </CardContent>
        </Card>
        <Card className="border-0 bg-amber-50">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-amber-700">{partial.length}</p>
            <p className="text-xs text-amber-600 mt-0.5">Partiellement disponibles</p>
          </CardContent>
        </Card>
        <Card className="border-0 bg-slate-100">
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-2xl font-bold text-slate-600">{fullyOccupied.length}</p>
            <p className="text-xs text-slate-500 mt-0.5">Entièrement occupés</p>
          </CardContent>
        </Card>
      </div>

      {/* Fully free */}
      {fullyFree.length > 0 && (
        <EmployeeSection
          title={`Entièrement libres (${fullyFree.length})`}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
          employees={fullyFree}
          fromDate={fromDate}
        />
      )}

      {/* Partially free */}
      {partial.length > 0 && (
        <EmployeeSection
          title={`Partiellement disponibles (${partial.length})`}
          icon={<AlertCircle className="h-4 w-4 text-amber-500" />}
          employees={partial}
          fromDate={fromDate}
        />
      )}

      {/* Fully occupied */}
      {fullyOccupied.length > 0 && (
        <EmployeeSection
          title={`Entièrement occupés (${fullyOccupied.length})`}
          icon={<XCircle className="h-4 w-4 text-slate-400" />}
          employees={fullyOccupied}
          fromDate={fromDate}
          muted
        />
      )}
    </div>
  )
}

// ─── EmployeeSection ──────────────────────────────────────────────────────────

function EmployeeSection({
  title,
  icon,
  employees,
  fromDate,
  muted = false,
}: {
  title: string
  icon: React.ReactNode
  employees: EmployeeAvailability[]
  fromDate: string
  muted?: boolean
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      <div className="space-y-2">
        {employees.map((emp) => (
          <EmployeeRow key={emp.id} emp={emp} fromDate={fromDate} muted={muted} />
        ))}
      </div>
    </section>
  )
}

// ─── EmployeeRow ──────────────────────────────────────────────────────────────

function EmployeeRow({
  emp,
  fromDate,
  muted,
}: {
  emp: EmployeeAvailability
  fromDate: string
  muted: boolean
}) {
  return (
    <Card className={`border ${muted ? "border-slate-100 opacity-70" : "border-slate-100"}`}>
      <CardContent className="p-3 space-y-2">
        {/* Name + team + counter */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-sm text-slate-800 truncate">
              {emp.firstName} {emp.lastName}
            </span>
            {emp.jobTitle && (
              <span className="text-xs text-slate-400 truncate hidden sm:inline">
                — {emp.jobTitle}
              </span>
            )}
            {emp.team && (
              <Badge
                className="text-[10px] px-1.5 shrink-0"
                style={{
                  backgroundColor: emp.team.color ? emp.team.color + "22" : "#0f346022",
                  color: emp.team.color ?? "#0f3460",
                  border: `1px solid ${emp.team.color ?? "#0f3460"}44`,
                }}
              >
                {emp.team.name}
              </Badge>
            )}
            {!emp.team && (
              <span className="text-[10px] text-slate-400 shrink-0">Sans équipe</span>
            )}
          </div>
          <span className={`text-xs font-medium shrink-0 ${
            emp.totalFreeDays === emp.totalDays
              ? "text-emerald-600"
              : emp.totalFreeDays > 0
              ? "text-amber-600"
              : "text-slate-400"
          }`}>
            {emp.totalFreeDays} / {emp.totalDays} jours libres
          </span>
        </div>

        {/* Timeline bar */}
        <TimelineBar segments={emp.timeline} totalDays={emp.totalDays} />

        {/* Free windows */}
        {emp.freeWindows.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {emp.freeWindows.map((w, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-0.5 rounded-full"
              >
                <CheckCircle2 className="h-3 w-3 shrink-0" />
                Du {fmtRange(w.from, w.to)}
                <span className="text-emerald-500 font-medium">
                  ({w.days} j)
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400 italic">
            Aucune disponibilité sur la période
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ─── TimelineBar ──────────────────────────────────────────────────────────────

function TimelineBar({
  segments,
  totalDays,
}: {
  segments: TimelineSegment[]
  totalDays: number
}) {
  return (
    <div className="flex h-3 rounded-full overflow-hidden gap-px bg-slate-200">
      {segments.map((seg, i) => {
        const pct = (seg.count / totalDays) * 100
        return (
          <div
            key={i}
            title={`${seg.count} jour${seg.count > 1 ? "s" : ""} ${seg.occupied ? "occupé" : "libre"}${seg.count > 1 ? "s" : ""}`}
            style={{ width: `${pct}%` }}
            className={`h-full transition-all ${
              seg.occupied ? "bg-slate-400" : "bg-emerald-400"
            }`}
          />
        )
      })}
    </div>
  )
}
