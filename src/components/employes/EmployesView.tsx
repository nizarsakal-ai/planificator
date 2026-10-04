"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { Users } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import {
  applyEmployeeView,
  buildTeamOptions,
  countActiveEmployeeFilters,
  DEFAULT_EMPLOYEE_STATE,
  EMPLOYEE_STATE_LABELS,
  EMPTY_EMPLOYEE_FILTERS,
  type EmployeeFilters,
  type EmployeeFunction,
  type EmployeeStateFilter,
  type EmployeeViewItem,
} from "@/lib/employes/employes-view"
import { EmployesToolbar, type EmployeViewMode } from "./EmployesToolbar"
import { EmployeGroupSection } from "./EmployeGroupSection"

export function EmployesView({ employees }: { employees: EmployeeViewItem[] }) {
  const [view, setView] = useState<EmployeViewMode>("grid")
  const [state, setState] = useState<EmployeeStateFilter>(DEFAULT_EMPLOYEE_STATE)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState<EmployeeFilters>(EMPTY_EMPLOYEE_FILTERS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<EmployeeFunction>>(new Set())

  const deferredSearch = useDeferredValue(search)

  const { groups, total, counts } = useMemo(
    () => applyEmployeeView(employees, { state, search: deferredSearch, filters }),
    [employees, state, deferredSearch, filters]
  )
  const teamOptions = useMemo(() => buildTeamOptions(employees), [employees])
  const activeFilterCount = countActiveEmployeeFilters(filters)

  const toggleGroup = (f: EmployeeFunction) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })

  const fallbackState = (["active", "archived", "all"] as const).find((s) => s !== state && counts[s] > 0)

  return (
    <div className="space-y-5">
      <EmployesToolbar
        state={state}
        counts={counts}
        onStateChange={setState}
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        onFiltersChange={setFilters}
        activeFilterCount={activeFilterCount}
        onReset={() => setFilters(EMPTY_EMPLOYEE_FILTERS)}
        teamOptions={teamOptions}
        view={view}
        onViewChange={setView}
      />

      {total === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="mx-auto mb-3 h-8 w-8 text-slate-200" />
            <p className="font-medium text-slate-500">
              Aucun employé ne correspond dans « {EMPLOYEE_STATE_LABELS[state]} ».
            </p>
            {fallbackState && (
              <button
                type="button"
                onClick={() => setState(fallbackState)}
                className="mt-2 text-sm font-medium text-[#0f3460] underline underline-offset-2"
              >
                Voir {EMPLOYEE_STATE_LABELS[fallbackState]} ({counts[fallbackState]})
              </button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <EmployeGroupSection
              key={group.fonction}
              group={group}
              view={view}
              collapsed={collapsed.has(group.fonction)}
              onToggle={() => toggleGroup(group.fonction)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
