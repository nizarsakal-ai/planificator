/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2E
 * CLI : amorçage de la configuration de routage d'une société à partir de son éligibilité legacy (plan I8).
 *
 * Usage :
 *   npx tsx scripts/lot2-seed-routing-pilot.ts --companyId=<id> --actorUserId=<id>          (simulation, défaut)
 *   npx tsx scripts/lot2-seed-routing-pilot.ts --companyId=<id> --actorUserId=<id> --apply  (écriture)
 *
 * - Simulation par défaut : lit, calcule et affiche le plan ; n'écrit rien.
 * - `--apply` : crée Sources, Rules et Bindings via la façade d'administration (AuthZ + audit history_logs,
 *   aucune valeur journalisée). Rejouable : une Source déjà complète (même nom) n'est pas recréée ; une Source
 *   restée incomplète après un échec est complétée.
 * - L'acteur doit être ADMIN de cette société, ou SUPER_ADMIN (vérifié en base).
 * - Sortie : compteurs et noms de partenaires seulement — jamais de domaine ni d'email.
 * - N'active AUCUN flag : sans INTEGRATION_ROUTING_*, la configuration n'a aucun effet sur le routage.
 */
import { pathToFileURL } from "node:url"
import { prisma } from "@/lib/prisma"
import {
  applyPilotSeedPlan,
  buildPilotSeedPlan,
  summarizePilotSeedPlan,
  type LegacyPartnerInput,
} from "@/lib/integration/sources/pilot-seed"
import { RoutingConfigAdminService } from "@/lib/integration/sources/routing-config-admin.service"

export function parseSeedArgs(argv: string[] = process.argv) {
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  return { companyId: arg("companyId"), actorUserId: arg("actorUserId"), apply: argv.includes("--apply") }
}

async function main() {
  const { companyId, actorUserId, apply } = parseSeedArgs()
  if (!companyId || !actorUserId) {
    console.error("Usage: --companyId=<id> --actorUserId=<id> [--apply]")
    process.exit(1)
  }
  const user = await prisma.user.findUnique({ where: { id: actorUserId }, select: { id: true, role: true, companyId: true } })
  const allowed = user && (user.role === "SUPER_ADMIN" || (user.role === "ADMIN" && user.companyId === companyId))
  if (!user || !allowed) {
    console.error("Acteur refusé : ADMIN de cette société ou SUPER_ADMIN requis.")
    process.exit(3)
  }

  const partners = await prisma.acquisitionPartner.findMany({
    where: { companyId },
    select: {
      id: true, name: true, pipeline: true, active: true, requireExactEmail: true,
      domains: { select: { domainNormalized: true, active: true } },
      emails: { select: { emailNormalized: true, active: true } },
    },
  })
  const input: LegacyPartnerInput[] = partners.map((p) => ({
    id: p.id, name: p.name, pipeline: p.pipeline, active: p.active, requireExactEmail: p.requireExactEmail,
    domains: p.domains.map((d) => ({ value: d.domainNormalized, active: d.active })),
    emails: p.emails.map((e) => ({ value: e.emailNormalized, active: e.active })),
  }))
  const existing = await prisma.inboundSource.findMany({
    where: { companyId },
    select: {
      id: true, displayName: true, enabled: true,
      rules: { where: { enabled: true }, select: { type: true, normalizedValue: true } },
      bindings: { select: { id: true, enabled: true } },
    },
  })
  const plan = buildPilotSeedPlan(input, existing.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    enabled: s.enabled,
    ruleKeys: s.rules.map((r) => `${r.type}|${r.normalizedValue}`),
    activeBindingId: s.bindings.find((b) => b.enabled)?.id ?? null,
    inactiveBindingIds: s.bindings.filter((b) => !b.enabled).map((b) => b.id),
  })))
  const summary = summarizePilotSeedPlan(plan)

  if (!apply) {
    console.info(JSON.stringify({ mode: "simulation", companyId, partnersRead: partners.length, ...summary }, null, 2))
    return
  }
  const result = await applyPilotSeedPlan(plan, { companyId, userId: user.id, role: user.role }, new RoutingConfigAdminService())
  console.info(JSON.stringify({ mode: "apply", companyId, partnersRead: partners.length, ...summary, created: result.created.length, completed: result.completed.length, failed: result.failed }, null, 2))
  if (result.failed.length > 0) process.exit(2)
}

const isDirectRun = typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main()
    .catch((e) => {
      console.error(e instanceof Error ? e.name : "seed failed")
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
