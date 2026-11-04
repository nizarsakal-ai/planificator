import Link from "next/link"
import { ArrowRight, Briefcase, CalendarDays, ChevronRight, FileText, Radar } from "lucide-react"
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

const KIND_ROWS: ReadonlyArray<{ kind: ProspectKind; icon: React.ElementType; tint: string; label: string; hint: string }> = [
  { kind: "TENDER", icon: FileText, tint: "bg-blue-50 text-blue-600", label: "Appels d'offres", hint: "Marchés ouverts" },
  { kind: "AWARD", icon: Briefcase, tint: "bg-purple-50 text-purple-600", label: "Sous-traitance", hint: "Titulaires à démarcher" },
  { kind: "EVENT", icon: CalendarDays, tint: "bg-orange-50 text-orange-600", label: "Calendrier", hint: "Festivals récurrents" },
]

const KIND_CHIP: Readonly<Record<ProspectKind, string>> = {
  TENDER: "bg-blue-50 text-blue-700",
  AWARD: "bg-purple-50 text-purple-700",
  EVENT: "bg-orange-50 text-orange-700",
}

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
    <Card className="overflow-hidden rounded-[22px]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blue-100/70 px-4 pb-3.5 pt-4 md:px-5 md:pt-[18px]">
        <div>
          <h2 className="flex items-center gap-2.5 text-[15px] font-bold text-slate-900">
            <span className="grid h-[30px] w-[30px] place-items-center rounded-[10px] bg-slate-100 text-[#0f3460]">
              <Radar className="h-4 w-4" />
            </span>
            Opportunités prospection
          </h2>
          <p className="mt-1 text-xs text-slate-500">Veille sur sources publiques · les meilleures pistes à qualifier</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-green-50 px-2.5 py-1 text-[11.5px] font-semibold text-green-700">
          <span className="relative flex h-[7px] w-[7px]">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-green-600" />
          </span>
          Veille active · {collectedAtLabel(lastCollectedAt, now)}
        </span>
      </div>

      <div className="grid lg:grid-cols-[260px_1fr]">
        <div className="grid grid-cols-3 content-start gap-1.5 border-b border-blue-100/70 bg-gradient-to-b from-[#0f3460]/[0.03] to-transparent p-3 lg:grid-cols-1 lg:gap-2 lg:border-b-0 lg:border-r lg:p-4">
          {KIND_ROWS.map(({ kind, icon: Icon, tint, label, hint }) => (
            <Link
              key={kind}
              href={`/opportunites?onglet=${KIND_TAB_SLUGS[kind]}`}
              className="flex flex-col items-start gap-1 rounded-[14px] border border-blue-100/70 bg-white px-2.5 py-2.5 outline-none transition-colors hover:border-blue-200 focus-visible:ring-2 focus-visible:ring-blue-500 lg:flex-row lg:items-center lg:gap-2.5 lg:px-3"
            >
              <span className={`hidden h-7 w-7 shrink-0 place-items-center rounded-[9px] lg:grid ${tint}`}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-[12.5px] font-semibold leading-tight text-slate-700">
                {label}
                <span className="hidden text-[11px] font-medium text-slate-500 lg:block">{hint}</span>
              </span>
              <span className="text-xl font-bold tracking-tight text-slate-900 tabular-nums lg:ml-auto">{counts[kind]}</span>
            </Link>
          ))}
          <div className="col-span-3 flex items-center gap-2 rounded-[14px] bg-gradient-to-br from-[#0f3460] to-[#1e4f8f] px-3 py-2.5 text-[12.5px] text-white lg:col-span-1 lg:mt-1">
            <span className="text-xl font-bold tabular-nums">{newSince24h}</span>
            nouvelle{newSince24h > 1 ? "s" : ""} piste{newSince24h > 1 ? "s" : ""} depuis hier
          </div>
        </div>

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
                  className="flex items-start gap-3 border-blue-100/70 px-2 py-3 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500 md:items-center md:gap-3.5 md:px-3 [&+&]:border-t"
                >
                  <ScoreRing score={o.score} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-semibold text-slate-900 md:truncate">{sentenceCase(o.title)}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500">
                      <span className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${KIND_CHIP[kind]}`}>
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

      <div className="flex flex-col-reverse items-start justify-between gap-2 border-t border-blue-100/70 px-4 py-3 md:flex-row md:items-center md:px-5">
        <p className="text-[11.5px] text-slate-500">
          Sources : {sources.length > 0 ? sources.map((s) => SOURCE_ATTRIBUTION[s]).join(" · ") : "données publiques, Licence Ouverte 2.0"}.
          Rien n&apos;est envoyé automatiquement.
        </p>
        <Link
          href="/opportunites"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-[12.5px] font-semibold text-[#0f3460] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Voir toutes les opportunités <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </Card>
  )
}
