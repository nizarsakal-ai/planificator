/**
 * PLAN-ACQ-012-LOT-1.2 — Bootstrap opérationnel du registre Sources d'acquisition.
 *
 * Préconditions :
 * - `DATABASE_URL` obligatoire (jamais affiché dans les logs) ;
 * - migration LOT-1.1 (`acquisition_partners` / `acquisition_partner_domains`) appliquée ;
 * - script rejouable / idempotent (y compris sous concurrence PostgreSQL) ;
 * - aucun domaine autre que `lauralu.fr` n’est créé.
 *
 * Usage :
 *   DATABASE_URL="..." npx tsx scripts/bootstrap-acquisition-partner-registry.ts
 *   npm run db:bootstrap:acquisition-partners
 *
 * Exit codes :
 * - 0 : aucun conflit, aucune erreur technique ;
 * - 2 : au moins un conflit métier, aucune erreur technique ;
 * - 1 : au moins une Company en échec technique (prioritaire si conflits + erreurs).
 *
 * Ne modifie pas le runtime Acquisition (ELIGIBLE_SENDER_DOMAIN reste la gate).
 */
import { PrismaClient } from "@prisma/client"
import {
  bootstrapExitCode,
  bootstrapLauraluPartnerRegistry,
  type PartnerRegistryBootstrapDb,
  type PartnerRegistryBootstrapTx,
} from "../src/lib/acquisition/partner-registry-bootstrap"

const prisma = new PrismaClient()

function asBootstrapDb(client: PrismaClient): PartnerRegistryBootstrapDb {
  return {
    company: client.company,
    acquisitionPartner: client.acquisitionPartner,
    acquisitionPartnerDomain: client.acquisitionPartnerDomain,
    acquisitionPartnerEmail: client.acquisitionPartnerEmail,
    $transaction: (fn) =>
      client.$transaction((tx) => fn(tx as unknown as PartnerRegistryBootstrapTx)),
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquant — abort.")
    process.exitCode = 1
    return
  }

  console.log("PLAN-ACQ-V2 — bootstrap registre partenaires (seeds data-driven)…")
  try {
    const result = await bootstrapLauraluPartnerRegistry(asBootstrapDb(prisma))
    console.log(
      JSON.stringify(
        {
          companiesTotal: result.companiesTotal,
          companiesSucceeded: result.companiesSucceeded,
          companiesFailed: result.companiesFailed,
          partnersCreated: result.partnersCreated,
          domainsCreated: result.domainsCreated,
          alreadyPresent: result.alreadyPresent,
          concurrentlyCreated: result.concurrentlyCreated,
          conflicts: result.conflicts,
          failed: result.failed,
        },
        null,
        2
      )
    )

    const code = bootstrapExitCode(result)
    process.exitCode = code
    if (code === 0) {
      console.log("✓ Bootstrap terminé (idempotent).")
    } else if (code === 2) {
      console.error(
        `⚠ ${result.conflicts.length} conflit(s) métier — aucune écriture forcée.`
      )
    } else {
      console.error(
        `✗ ${result.companiesFailed} échec(s) technique(s)` +
          (result.conflicts.length > 0
            ? `, ${result.conflicts.length} conflit(s)`
            : "") +
          "."
      )
    }
  } catch {
    console.error("✗ Échec bootstrap (DATABASE_ERROR).")
    process.exitCode = 1
  }
}

main().finally(() => prisma.$disconnect())
