import Link from "next/link"
import { ArrowRight, ChevronRight } from "lucide-react"
import { Card } from "@/components/ui/card"
import { getDashboardProspection } from "@/lib/prospection/prospection-dashboard.repository"
import {
  KIND_SHORT_LABELS,
  KIND_TAB_SLUGS,
  awardedAgoLabel,
  collectedAtLabel,
  isNewOpportunity,
  isSoonDeadline,
} from "@/lib/prospection/prospection-dashboard"
import { BAND_LABELS, SOURCE_ATTRIBUTION, deadlineLabel, departmentsLabel, sentenceCase } from "@/lib/prospection/prospection-ui"
import type { ProspectBand, ProspectKind, ProspectSource } from "@/lib/prospection/prospection.types"

const KIND_ROWS: ReadonlyArray<{ kind: ProspectKind; label: string; hint: string }> = [
  { kind: "TENDER", label: "Appels d'offres", hint: "Marchés ouverts" },
  { kind: "AWARD", label: "Sous-traitance", hint: "Titulaires à démarcher" },
  { kind: "EVENT", label: "Calendrier", hint: "Festivals récurrents" },
]

const BAND_PILL: Readonly<Record<ProspectBand, string>> = {
  A_TRAITER: "bg-green-50 text-green-700",
  A_VERIFIER: "bg-amber-50 text-amber-700",
  MASQUE: "bg-slate-100 text-slate-600",
}

function ScoreRing({ score }: { score: number }) {
  const r = 19
  const c = 2 * Math.PI * r
  const color = score >= 70 ? "#16a34a" : score >= 50 ? "#f59e0b" : "#94a3b8"
  return (
    <div className="relative grid h-11 w-11 shrink-0 place-items-center text-[13px] font-extrabold text-slate-900" aria-label={`Score ${score} sur 100`}>
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(15,52,96,0.10)" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      {score}
    </div>
  )
}

function fmtDay(date: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Paris" }).format(date)
}

/**
 * Bloc « Opportunités prospection » (veille V1) — composant serveur, lecture seule.
 * Rendu uniquement quand la page a vérifié `isProspectionNavVisible` (drapeau serveur + SUPER_ADMIN + société).
 */
export async function ProspectionBlock({ companyId }: { companyId: string }) {
  const now = new Date()
  const { counts, top, newSince24h, lastCollectedAt } = await getDashboardProspection(companyId, now)
  const sources = [...new Set(top.map((o) => o.source as ProspectSource))]

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-4 md:px-5">
        <div>
          <h2 className="text-[15px] font-semibold text-slate-900">Opportunités de prospection</h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {newSince24h > 0
              ? `${newSince24h} nouvelle${newSince24h > 1 ? "s" : ""} piste${newSince24h > 1 ? "s" : ""} depuis hier`
              : "Aucune nouvelle piste depuis hier"}
            {" · "}
            {collectedAtLabel(lastCollectedAt, now)}
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-[220px_1fr]">
        <nav aria-label="Types d'opportunités" className="grid grid-cols-3 border-b border-slate-100 lg:grid-cols-1 lg:content-start lg:border-b-0 lg:border-r">
          {KIND_ROWS.map(({ kind, label, hint }) => (
            <Link
              key={kind}
              href={`/opportunites?onglet=${KIND_TAB_SLUGS[kind]}`}
              className="-ml-px -mt-px flex flex-col gap-1 border-l border-t border-slate-100 px-4 py-3 outline-none transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0f3460] motion-reduce:transition-none lg:flex-row lg:items-baseline lg:justify-between"
            >
              <span className="text-[13px] leading-tight text-slate-600">
                {label}
                <span className="hidden text-xs text-slate-400 lg:block">{hint}</span>
              </span>
              <span className="text-xl font-semibold tracking-tight text-slate-900 tabular-nums">{counts[kind]}</span>
            </Link>
          ))}
        </nav>

        <div className="p-1.5 md:p-2">
          {top.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-slate-400">
              Aucune piste ouverte pour l&apos;instant. La veille collecte les sources chaque matin.
            </p>
          ) : (
            top.map((o) => {
              const kind = o.kind as ProspectKind
              const departments = o.departmentCodes.length > 0 ? departmentsLabel(o.departmentCodes) : null
              const who = kind === "AWARD" && o.winners.length > 0 ? `Titulaire : ${o.winners.slice(0, 2).join(", ")}` : o.organization
              const due =
                kind === "TENDER" ? deadlineLabel(o.deadlineAt, now) ?? "Date limite non publiée"
                  : kind === "AWARD" ? awardedAgoLabel(o.publishedAt, now)
                    : o.eventPeriod ?? (o.eventStartAt ? `Le ${fmtDay(o.eventStartAt)}` : null)
              const soon = kind === "TENDER" && isSoonDeadline(o.deadlineAt, now)
              return (
                <Link
                  key={o.id}
                  href={`/opportunites?onglet=${KIND_TAB_SLUGS[kind]}`}
                  className="flex items-start gap-3 border-slate-100 px-2 py-3 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-[#0f3460] md:items-center md:gap-3.5 md:px-3 [&+&]:border-t"
                >
                  <ScoreRing score={o.score} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-slate-900 md:truncate">{sentenceCase(o.title)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
                      <span className={`font-medium text-slate-700`}>
                        {KIND_SHORT_LABELS[kind]}
                      </span>
                      {who && <span>{who}</span>}
                      {departments && <span>{departments === "Île-de-France" ? departments : `Dép. ${departments}`}</span>}
                      {due && <span className={`font-semibold ${soon ? "text-amber-600" : "text-slate-700"}`}>{due}</span>}
                      {isNewOpportunity(o.firstSeenAt, now) && (
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">Nouveau</span>
                      )}
                    </div>
                  </div>
                  <span className={`hidden shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-semibold md:inline ${BAND_PILL[o.band as ProspectBand] ?? BAND_PILL.MASQUE}`}>
                    {BAND_LABELS[o.band as ProspectBand] ?? o.band}
                  </span>
                  <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-400 md:block" />
                </Link>
              )
            })
          )}
        </div>
      </div>

      <div className="flex flex-col-reverse items-start justify-between gap-2 border-t border-slate-100 px-4 py-3 md:flex-row md:items-center md:px-5">
        <p className="text-[11.5px] text-slate-500">
          Sources : {sources.length > 0 ? sources.map((s) => SOURCE_ATTRIBUTION[s]).join(" · ") : "données publiques, Licence Ouverte 2.0"}.
          Rien n&apos;est envoyé automatiquement.
        </p>
        <Link
          href="/opportunites"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-[12.5px] font-semibold text-[#0f3460] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[#0f3460]"
        >
          Voir toutes les opportunités <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Card>
  )
}
