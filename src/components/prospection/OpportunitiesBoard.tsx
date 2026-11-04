"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"
import { ExternalLink } from "lucide-react"
import { updateOpportunityStatusAction } from "@/lib/prospection/prospection.actions"
import type { OpportunityListItem } from "@/lib/prospection/prospection.repository"
import {
  BAND_BADGE_CLASS,
  BAND_LABELS,
  OPPORTUNITY_TABS,
  SOURCE_ATTRIBUTION,
  STATUS_LABELS,
  deadlineLabel,
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

function fmtDay(d: Date | string | null) {
  if (!d) return null
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(d))
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
      className="h-8 rounded-md border bg-background px-2 text-xs disabled:opacity-60"
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

function OpportunityCard({ item, now }: { item: OpportunityListItem; now: Date }) {
  const band = item.band as ProspectBand
  const reasons = (Array.isArray(item.scoreReasons) ? item.scoreReasons : []) as unknown as ScoreReason[]
  const deadline = item.deadlineAt ? new Date(item.deadlineAt) : null
  const place = [item.locality, ...item.departmentCodes.map((code) => `${DEPARTMENT_LABELS.get(code) ?? "Département"} (${code})`)]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", BAND_BADGE_CLASS[band])}>
              {item.score} · {BAND_LABELS[band]}
            </span>
            {item.status === "NOUVEAU" ? <span className="text-xs font-medium text-sky-700 dark:text-sky-300">Nouveau</span> : null}
          </div>
          <h3 className="text-sm font-semibold leading-snug text-foreground">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-start gap-1 underline-offset-2 hover:underline">
                <span>{item.title}</span>
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              </a>
            ) : (
              item.title
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {[item.organization, place].filter(Boolean).join(" — ") || "Lieu non précisé"}
          </p>
        </div>
        <StatusSelect id={item.id} status={item.status as ProspectStatus} />
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {item.kind === "TENDER" ? (
          <div>
            <dt className="inline text-muted-foreground">Date limite : </dt>
            <dd className="inline font-medium">{deadline ? `${fmtDay(deadline)} (${deadlineLabel(deadline, now)})` : "non publiée"}</dd>
          </div>
        ) : null}
        {item.kind !== "EVENT" && item.publishedAt ? (
          <div>
            <dt className="inline text-muted-foreground">Publié le : </dt>
            <dd className="inline">{fmtDay(item.publishedAt)}</dd>
          </div>
        ) : null}
        {item.kind === "EVENT" && item.eventPeriod ? (
          <div>
            <dt className="inline text-muted-foreground">Période : </dt>
            <dd className="inline">{item.eventPeriod}</dd>
          </div>
        ) : null}
        {item.winners.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="inline text-muted-foreground">Titulaire(s) à démarcher : </dt>
            <dd className="inline font-medium">{item.winners.join(", ")}</dd>
          </div>
        ) : null}
        {item.awardedTo.length > 0 ? (
          <div className="sm:col-span-2">
            <dt className="inline text-muted-foreground">Attribué à :</dt>
            <dd className="inline font-medium">{item.awardedTo.join(", ")}</dd>
          </div>
        ) : null}
      </dl>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">Pourquoi ce score ?</summary>
        <ul className="mt-2 space-y-0.5">
          {reasons.map((reason) => (
            <li key={reason.code} className="flex justify-between gap-3">
              <span>{reason.label}</span>
              <span className="tabular-nums text-muted-foreground">{reason.points > 0 ? `+${reason.points}` : reason.points}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">Source : {SOURCE_ATTRIBUTION[item.source as ProspectSource]}</p>
      </details>
    </li>
  )
}

export function OpportunitiesBoard({
  items,
  counts,
  tabSlug,
  filters,
  limit,
}: {
  items: OpportunityListItem[]
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
    <div className="space-y-4">
      <nav aria-label="Types d'opportunités" className="flex flex-wrap gap-2">
        {OPPORTUNITY_TABS.map((t) => (
          <Link
            key={t.slug}
            href={hrefWith({ onglet: t.slug })}
            aria-current={t.slug === tab.slug ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              t.slug === tab.slug ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {t.label} <span className="tabular-nums opacity-75">{counts[t.kind]}</span>
          </Link>
        ))}
      </nav>
      <p className="text-sm text-muted-foreground">{tab.hint}</p>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Département</span>
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={filters.departmentCode ?? ""}
            onChange={(e) => router.push(hrefWith({ dept: e.target.value || null }))}
          >
            <option value="">Toute la France</option>
            {[...DEPARTMENT_LABELS].map(([code, label]) => (
              <option key={code} value={code}>{code} — {label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Suivi</span>
          <select
            className="h-9 rounded-md border bg-background px-3"
            value={filters.status ?? ""}
            onChange={(e) => router.push(hrefWith({ statut: e.target.value || null }))}
          >
            <option value="">Tous</option>
            {PROSPECT_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.includeHidden}
            onChange={(e) => router.push(hrefWith({ masques: e.target.checked ? "1" : null }))}
          />
          <span className="text-muted-foreground">Afficher les pistes masquées</span>
        </label>
        <span className="text-xs text-muted-foreground">{items.length} résultat(s) · max {limit}</span>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          Aucune opportunité pour ces critères. La collecte a lieu chaque matin.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <OpportunityCard key={item.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </div>
  )
}
