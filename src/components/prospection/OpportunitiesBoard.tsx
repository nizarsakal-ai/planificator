"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { updateOpportunityStatusAction } from "@/lib/prospection/prospection.actions"
import type { OpportunityListItem, RecentlyClosedTender } from "@/lib/prospection/prospection.repository"
import { priorityGroupsFor } from "@/lib/prospection/priority"
import {
  BAND_LABELS,
  OPPORTUNITY_TABS,
  SOURCE_ATTRIBUTION,
  STATUS_LABELS,
  deadlineLabel,
  departmentsLabel,
  sentenceCase,
  tabForSlug,
} from "@/lib/prospection/prospection-ui"
import { DEPARTMENT_LABELS } from "@/lib/prospection/sources/departments"
import {
  PROSPECT_STATUSES,
  type ProspectBand,
  type ProspectKind,
  type ProspectSource,
  type ProspectStatus,
  type ScoreReason,
} from "@/lib/prospection/prospection.types"
import { cn } from "@/lib/utils"

const DAY_MS = 24 * 60 * 60 * 1000

const SCORE_CLASS: Readonly<Record<ProspectBand, string>> = {
  A_TRAITER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  A_VERIFIER: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  MASQUE: "bg-muted text-muted-foreground",
}

function fmtShort(d: Date | string | null) {
  if (!d) return ""
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" }).format(new Date(d))
}

function StatusSelect({ id, status }: { id: string; status: ProspectStatus }) {
  const router = useRouter()
  const [value, setValue] = useState(status)
  const [pending, startTransition] = useTransition()

  function onChange(next: ProspectStatus) {
    const previous = value
    setValue(next)
    startTransition(async () => {
      const result = await updateOpportunityStatusAction(id, next)
      if (!result.ok) {
        setValue(previous)
        toast.error(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <select
      aria-label="Statut de suivi"
      className="h-8 rounded-md border bg-background px-2 text-xs text-muted-foreground disabled:opacity-60"
      value={value}
      disabled={pending}
      onChange={(e) => onChange(e.target.value as ProspectStatus)}
    >
      {PROSPECT_STATUSES.map((s) => (
        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
      ))}
    </select>
  )
}

function WhenLabel({ item, now }: { item: OpportunityListItem; now: Date }) {
  if (item.kind === "TENDER") {
    if (!item.deadlineAt) return <span>Limite non publiée</span>
    const deadline = new Date(item.deadlineAt)
    const soon = deadline.getTime() - now.getTime() < 10 * DAY_MS
    const label = deadlineLabel(deadline, now)?.replace("Dans ", "").replace(" jours", " j")
    return <span className={cn(soon && "font-semibold text-red-700 dark:text-red-400")}>Limite {fmtShort(deadline)} · {label}</span>
  }
  if (item.kind === "AWARD") return item.publishedAt ? <span>Attribué le {fmtShort(item.publishedAt)}</span> : null
  return item.eventPeriod ? <span>{item.eventPeriod.replace(/\s*\(.*\)$/, "")}</span> : null
}

function OpportunityRow({ item, now }: { item: OpportunityListItem; now: Date }) {
  const band = item.band as ProspectBand
  const reasons = (Array.isArray(item.scoreReasons) ? item.scoreReasons : []) as unknown as ScoreReason[]
  const who = item.organization ? sentenceCase(item.organization) : item.locality
  const where = item.departmentCodes.length ? departmentsLabel(item.departmentCodes) : null
  const title = sentenceCase(item.title)

  return (
    <li className="grid grid-cols-[2.5rem_1fr] items-start gap-3 border-t px-4 py-3 first:border-t-0 sm:grid-cols-[2.75rem_1fr_auto]">
      <span
        title={BAND_LABELS[band]}
        className={cn("grid h-10 w-10 place-items-center rounded-xl text-sm font-bold tabular-nums", SCORE_CLASS[band])}
      >
        {item.score}
      </span>
      <div className="min-w-0">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="line-clamp-2 font-semibold text-foreground underline-offset-2 hover:underline">
            {title}
          </a>
        ) : (
          <p className="line-clamp-2 font-semibold text-foreground">{title}</p>
        )}
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] text-muted-foreground">
          <span>{[who, where].filter(Boolean).join(" · ") || "Lieu non précisé"}</span>
          <span className="border-l pl-2"><WhenLabel item={item} now={now} /></span>
        </p>
        {item.winners.length > 0 ? (
          <p className="mt-1 text-[13px]">À démarcher : <b>{item.winners.join(" · ")}</b></p>
        ) : null}
        {item.awardedTo.length > 0 ? (
          <p className="mt-1 text-[13px] text-muted-foreground">Attribué à : {item.awardedTo.join(" · ")}</p>
        ) : null}
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer list-none text-muted-foreground [&::-webkit-details-marker]:hidden">Pourquoi {item.score} ?</summary>
          <ul className="mt-1.5 space-y-0.5">
            {reasons.map((reason) => (
              <li key={reason.code} className="flex justify-between gap-3">
                <span>{reason.label}</span>
                <span className="tabular-nums text-muted-foreground">{reason.points > 0 ? `+${reason.points}` : reason.points}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">Source : {SOURCE_ATTRIBUTION[item.source as ProspectSource]}</p>
        </details>
      </div>
      <div className="col-start-2 sm:col-start-auto">
        <StatusSelect id={item.id} status={item.status as ProspectStatus} />
      </div>
    </li>
  )
}

function ClosedLine({ items }: { items: RecentlyClosedTender[] }) {
  if (items.length === 0) return null
  return (
    <details className="mx-0.5 mt-2 text-[13px]">
      <summary className="cursor-pointer font-medium text-primary">
        Clos récemment · {items.length} — à recontacter au prochain marché
      </summary>
      <ul className="mt-1.5 space-y-1 border-l-2 pl-3 text-muted-foreground">
        {items.map((item) => (
          <li key={item.id}>
            <b className="font-semibold text-foreground">{sentenceCase(item.organization ?? "")}</b>
            {" — "}
            {item.url ? (
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">{sentenceCase(item.title)}</a>
            ) : sentenceCase(item.title)}
            <span className="whitespace-nowrap"> · clos le {fmtShort(item.deadlineAt)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function OpportunitiesBoard({
  items,
  recentlyClosed,
  counts,
  tabSlug,
  filters,
  limit,
}: {
  items: OpportunityListItem[]
  recentlyClosed: RecentlyClosedTender[]
  counts: Record<ProspectKind, number>
  tabSlug: string
  filters: { departmentCode: string | null; status: ProspectStatus | null; includeHidden: boolean }
  limit: number
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tab = tabForSlug(tabSlug)
  const now = new Date()

  function hrefWith(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    const q = params.toString()
    return q ? `/opportunites?${q}` : "/opportunites"
  }

  return (
    <div className="space-y-3">
      <nav aria-label="Types d'opportunités" className="flex flex-wrap gap-1.5 border-b pb-2.5">
        {OPPORTUNITY_TABS.map((t) => {
          const active = t.slug === tab.slug
          return (
            <Link
              key={t.slug}
              href={hrefWith({ onglet: t.slug })}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors",
                active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t.label}
              <span className={cn("rounded-full px-2 text-xs font-semibold tabular-nums", active ? "bg-background text-foreground" : "bg-muted text-foreground")}>
                {counts[t.kind]}
              </span>
            </Link>
          )
        })}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">{tab.hint}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="Département"
            className="h-8 rounded-md border bg-background px-2"
            value={filters.departmentCode ?? ""}
            onChange={(e) => router.push(hrefWith({ dept: e.target.value || null }))}
          >
            <option value="">Toute la France</option>
            {[...DEPARTMENT_LABELS].map(([code, label]) => (
              <option key={code} value={code}>{code} — {label}</option>
            ))}
          </select>
          <select
            aria-label="Suivi"
            className="h-8 rounded-md border bg-background px-2"
            value={filters.status ?? ""}
            onChange={(e) => router.push(hrefWith({ statut: e.target.value || null }))}
          >
            <option value="">Tout suivi</option>
            {PROSPECT_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={filters.includeHidden}
              onChange={(e) => router.push(hrefWith({ masques: e.target.checked ? "1" : null }))}
            />
            Masquées
          </label>
        </div>
      </div>

      {priorityGroupsFor(tab.kind).map((group, index) => {
        const inGroup = items.filter((item) => item.priorityGroup === group.rank)
        const closed = recentlyClosed.filter((item) => item.priorityGroup === group.rank)
        const empty = inGroup.length === 0
        return (
          <section key={group.rank} aria-label={group.label} className="pb-2">
            <h2 className={cn("mb-2 flex items-center gap-2.5 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground", empty && closed.length === 0 && "opacity-45")}>
              <span className={cn("grid h-[22px] w-[22px] place-items-center rounded-full text-xs normal-case text-background", empty && closed.length === 0 ? "bg-muted-foreground" : "bg-primary")}>
                {index + 1}
              </span>
              {group.label}
              <span className="ml-auto tabular-nums">{inGroup.length}</span>
            </h2>
            {empty ? null : (
              <ul className="overflow-hidden rounded-2xl border bg-card">
                {inGroup.map((item) => (
                  <OpportunityRow key={item.id} item={item} now={now} />
                ))}
              </ul>
            )}
            <ClosedLine items={closed} />
          </section>
        )
      })}

      <p className="text-xs text-muted-foreground">
        {items.length} piste(s) affichée(s) · max {limit}. La collecte a lieu chaque matin ; rien n&apos;est envoyé automatiquement.
      </p>
    </div>
  )
}
