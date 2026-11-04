/**
 * Veille prospection — handler du cron quotidien `/api/cron/prospection-veille`.
 * Protégé par CRON_SECRET ; inactif (200 « skipped ») tant que PROSPECTION_WATCH_ENABLED n'est pas à "true".
 * Indépendant de l'orchestrateur d'acquisition : aucune dépendance, aucun bail partagé.
 */
import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import {
  getBoampLookbackDays,
  getDatatourismeFluxUrl,
  getProspectionWatchCompanyIds,
  isProspectionWatchEnabled,
} from "@/lib/prospection/prospection-feature-flag"
import { prospectionRepository } from "@/lib/prospection/prospection.repository"
import { runProspectionWatch, type ProspectionWatchDeps } from "@/lib/prospection/prospection-watch.service"
import { fetchBoampCandidates } from "@/lib/prospection/sources/boamp.source"
import { fetchDatatourismeCandidates } from "@/lib/prospection/sources/datatourisme.source"
import { fetchFestivalCandidates } from "@/lib/prospection/sources/festivals-culture.source"

const LOG_PREFIX = "[prospection-veille]"
const NO_STORE = { "Cache-Control": "private, no-store" }

type Env = Readonly<Record<string, string | undefined>>

export function buildProspectionWatchDeps(env: Env = process.env, now = new Date()): ProspectionWatchDeps {
  const fluxUrl = getDatatourismeFluxUrl(env)
  return {
    companyIds: getProspectionWatchCompanyIds(env),
    now,
    repository: prospectionRepository,
    fetchBoamp: () => fetchBoampCandidates({ now, lookbackDays: getBoampLookbackDays(env) }),
    fetchFestivals: () => fetchFestivalCandidates(),
    fetchDatatourisme: fluxUrl ? async () => (await fetchDatatourismeCandidates({ fluxUrl })).candidates : null,
    log: (event, payload) => console.log(`${LOG_PREFIX} ${event}`, payload ?? {}),
  }
}

export async function handleProspectionWatchCron(
  req: Request,
  options: { env?: Env; buildDeps?: (env: Env) => ProspectionWatchDeps } = {},
): Promise<NextResponse> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const env = options.env ?? process.env
  if (!isProspectionWatchEnabled(env)) {
    return NextResponse.json({ status: "skipped", reason: "PROSPECTION_WATCH_DISABLED" }, { headers: NO_STORE })
  }

  try {
    const deps = (options.buildDeps ?? buildProspectionWatchDeps)(env)
    if (deps.companyIds.length === 0) {
      return NextResponse.json({ status: "skipped", reason: "NO_COMPANY_CONFIGURED" }, { headers: NO_STORE })
    }
    const result = await runProspectionWatch(deps)
    return NextResponse.json({ status: "ok", ...result }, { headers: NO_STORE })
  } catch (error) {
    console.error(`${LOG_PREFIX} run failed`, { name: error instanceof Error ? error.name : typeof error })
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers: NO_STORE })
  }
}
