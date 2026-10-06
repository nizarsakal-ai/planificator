"use client"

import { useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CalendarClock, CalendarDays, HardHat, Map as MapIcon, Plus, Truck, Zap } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { EquipeForm } from "@/components/equipes/EquipeForm"
import {
  formatDbDate,
  INTERVENTION_MARKER_COLOR,
  UPCOMING_SEE_ALL_HREF,
  UPCOMING_WINDOW_DAYS,
  type CurrentIntervention,
  type InterventionMapData,
  type QuickAction,
  type QuickActionId,
  type UpcomingIntervention,
} from "@/lib/equipes/equipes-view"
import { EquipeMark } from "./EquipeCard"

const EquipesMap = dynamic(() => import("./EquipesMap").then((m) => m.EquipesMap), {
  ssr: false,
  loading: () => <div className="h-44 animate-pulse rounded-lg bg-slate-100" aria-hidden="true" />,
})

/** Nombre de lignes visibles avant « Voir tout » (panneau compact). */
export const CURRENT_VISIBLE_LIMIT = 5

const FOCUS_RING =
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
const LINK = `rounded text-xs font-medium text-[#0f3460] hover:underline underline-offset-2 ${FOCUS_RING}`

interface Employee {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
}

interface EquipesSidePanelProps {
  current: CurrentIntervention[]
  map: InterventionMapData
  upcoming: { items: UpcomingIntervention[]; total: number }
  quickActions: QuickAction[]
  planningHref: string
  /** Pour « Nouvelle équipe » (même formulaire et même action que l'en-tête). */
  employees: Employee[]
}

function PanelBlock({
  id,
  title,
  Icon,
  children,
  footer,
}: {
  id: string
  title: string
  Icon: typeof MapIcon
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section aria-labelledby={`equipes-panel-${id}`} data-panel-block={id} className="rounded-xl border border-slate-100 bg-white p-3.5">
      <h2 id={`equipes-panel-${id}`} className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-slate-900">
        <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" />
        {title}
      </h2>
      {children}
      {footer && <div className="mt-2.5 border-t border-slate-100 pt-2">{footer}</div>}
    </section>
  )
}

function TeamLine({ team, primary, secondary, aside }: { team: CurrentIntervention["team"]; primary: string; secondary: string; aside?: string }) {
  return (
    <li className="flex items-center gap-2.5 py-1.5">
      <EquipeMark team={team} className="h-7 w-7 text-xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight text-slate-800">{primary}</p>
        <p className="truncate text-xs text-slate-500">{secondary}</p>
      </div>
      {aside && <span className="shrink-0 text-xs tabular-nums text-slate-500">{aside}</span>}
    </li>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`

function RepartitionBlock({ current, map }: { current: CurrentIntervention[]; map: InterventionMapData }) {
  const unlocalized = map.unlocalized.length
  return (
    <PanelBlock id="repartition" title="Répartition des équipes" Icon={MapIcon}>
      {map.markers.length > 0 ? (
        <>
          <EquipesMap markers={map.markers} />
          <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: INTERVENTION_MARKER_COLOR }} aria-hidden="true" />
            Équipe en intervention (chantier du jour)
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
          {current.length === 0 ? "Aucune équipe en intervention aujourd'hui." : "Aucun chantier du jour n'est géolocalisé."}
        </p>
      )}
      {unlocalized > 0 && (
        <p className="mt-1.5 text-xs text-amber-700" title={map.unlocalized.map((c) => `${c.team.name} — ${c.worksite.name}`).join("\n")}>
          {plural(unlocalized, "équipe")} non localisée{unlocalized > 1 ? "s" : ""} (chantier sans coordonnées)
        </p>
      )}
    </PanelBlock>
  )
}

function CurrentBlock({ current, planningHref }: { current: CurrentIntervention[]; planningHref: string }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? current : current.slice(0, CURRENT_VISIBLE_LIMIT)
  const hidden = current.length - visible.length
  return (
    <PanelBlock
      id="current"
      title={`Équipes en intervention (${current.length})`}
      Icon={HardHat}
      footer={
        <Link href={planningHref} className={LINK}>
          Voir le planning des équipes
        </Link>
      }
    >
      {current.length === 0 ? (
        <p className="text-xs text-slate-500">Aucune intervention confirmée aujourd&apos;hui.</p>
      ) : (
        <>
          <ul className="-my-1.5 divide-y divide-slate-50">
            {visible.map((c) => (
              <TeamLine key={c.team.id} team={c.team} primary={c.team.name} secondary={c.worksite.name} />
            ))}
          </ul>
          {(hidden > 0 || expanded) && current.length > CURRENT_VISIBLE_LIMIT && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className={`mt-1.5 ${LINK}`} aria-expanded={expanded}>
              {expanded ? "Réduire" : `Voir tout (${current.length})`}
            </button>
          )}
        </>
      )}
    </PanelBlock>
  )
}

function UpcomingBlock({ upcoming }: { upcoming: EquipesSidePanelProps["upcoming"] }) {
  return (
    <PanelBlock
      id="upcoming"
      title="Prochaines interventions"
      Icon={CalendarClock}
      footer={
        <Link href={UPCOMING_SEE_ALL_HREF} className={LINK}>
          Voir tout
        </Link>
      }
    >
      {upcoming.items.length === 0 ? (
        <p className="text-xs text-slate-500">Aucune intervention confirmée dans les {UPCOMING_WINDOW_DAYS} prochains jours.</p>
      ) : (
        <ul className="-my-1.5 divide-y divide-slate-50">
          {upcoming.items.map((u) => (
            <TeamLine
              key={u.team.id}
              team={u.team}
              primary={u.team.name}
              secondary={u.worksite.name}
              aside={formatDbDate(new Date(u.date))}
            />
          ))}
        </ul>
      )}
    </PanelBlock>
  )
}

const QUICK_ICONS: Record<QuickActionId, typeof Plus> = {
  newTeam: Plus,
  planning: CalendarDays,
  worksites: HardHat,
  vehicles: Truck,
}

const QUICK_ITEM = `flex min-h-10 items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-2 text-left text-xs font-medium text-slate-700 transition-colors hover:border-[#0f3460]/30 hover:bg-slate-50 ${FOCUS_RING}`

function QuickActionsBlock({ actions, employees }: { actions: QuickAction[]; employees: Employee[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  return (
    <PanelBlock id="quick" title="Actions rapides" Icon={Zap}>
      <div className="grid grid-cols-2 gap-2">
        {actions.map((a) => {
          const Icon = QUICK_ICONS[a.id]
          const content = (
            <>
              <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span className="min-w-0">{a.label}</span>
            </>
          )
          return a.href ? (
            <Link key={a.id} href={a.href} className={QUICK_ITEM} data-quick-action={a.id}>
              {content}
            </Link>
          ) : (
            <button key={a.id} type="button" onClick={() => setOpen(true)} className={QUICK_ITEM} data-quick-action={a.id}>
              {content}
            </button>
          )
        })}
      </div>
      {actions.some((a) => a.id === "newTeam") && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Nouvelle équipe</DialogTitle>
              <DialogDescription>Choisissez un nom, une couleur et un chef d&apos;équipe.</DialogDescription>
            </DialogHeader>
            <EquipeForm
              employees={employees}
              onSuccess={() => {
                setOpen(false)
                router.refresh()
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </PanelBlock>
  )
}

/** Panneau droit : exactement 4 blocs, dans l'ordre du visuel validé. */
export function EquipesSidePanel({ current, map, upcoming, quickActions, planningHref, employees }: EquipesSidePanelProps) {
  return (
    <aside aria-label="Synthèse des équipes" className="min-w-0 space-y-4">
      <RepartitionBlock current={current} map={map} />
      <CurrentBlock current={current} planningHref={planningHref} />
      <UpcomingBlock upcoming={upcoming} />
      <QuickActionsBlock actions={quickActions} employees={employees} />
    </aside>
  )
}
