/**
 * PLAN-ACQ-012-LOT-1.4-R4 — Preflight opérationnel bloquant (lecture seule).
 *
 * Préconditions :
 * - `DATABASE_URL` obligatoire (jamais affiché) ;
 * - migration LOT-1.1 appliquée ;
 * - bootstrap LOT-1.2 exécuté sur la cible explicitement sélectionnée.
 *
 * Usage :
 *   DATABASE_URL="..." npx tsx scripts/check-acquisition-partner-registry-readiness.ts
 *   npm run db:check:acquisition-partners-readiness
 *
 * Exit codes :
 * - 0 : au moins une Company et toutes prêtes (transition LAURALU exacte) ;
 * - 1 : aucune Company, Company non prête, ou erreur DB.
 *
 * Aucune écriture. Aucune réactivation. Ne jamais promouvoir LOT-1.4 si exit ≠ 0.
 */
import { PrismaClient } from "@prisma/client"
import {
  checkAcquisitionPartnerRegistryReadiness,
  readinessExitCode,
  type PartnerRegistryReadinessDb,
} from "../src/lib/acquisition/partner-registry-readiness"

const prisma = new PrismaClient()

function asReadinessDb(client: PrismaClient): PartnerRegistryReadinessDb {
  return {
    company: client.company,
    acquisitionPartner: client.acquisitionPartner,
    acquisitionPartnerDomain: client.acquisitionPartnerDomain,
    acquisitionPartnerEmail: client.acquisitionPartnerEmail,
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquant — abort.")
    process.exitCode = 1
    return
  }

  console.log(
    "PLAN-ACQ-V2 Lot I — preflight readiness multi-partenaires (lecture seule)…"
  )
  console.log(
    "Vérifiez explicitement que DATABASE_URL pointe vers la cible voulue (valeur jamais affichée)."
  )

  try {
    const report = await checkAcquisitionPartnerRegistryReadiness(
      asReadinessDb(prisma)
    )
    console.log(
      JSON.stringify(
        {
          companiesTotal: report.companiesTotal,
          companiesReady: report.companiesReady,
          companiesNotReady: report.companiesNotReady,
          missingActivePartner: report.missingActivePartner,
          missingActiveIdentity: report.missingActiveIdentity,
          databaseErrors: report.databaseErrors,
        },
        null,
        2
      )
    )

    const code = readinessExitCode(report)
    process.exitCode = code
    if (code === 0) {
      console.log(
        "✓ Preflight OK — ≥1 partenaire actif + identité (domaine|email) par Company."
      )
    } else {
      const noCompanies = report.databaseErrors.some(
        (e) => e.code === "NO_COMPANIES_FOUND"
      )
      console.error(
        "✗ Preflight KO — ne pas déployer / promouvoir LOT-1.4." +
          (noCompanies ? " Aucune Company trouvée." : "") +
          (report.databaseErrors.length > 0
            ? ` Erreurs: ${report.databaseErrors.length}.`
            : "") +
          (report.companiesNotReady > 0
            ? ` Companies non prêtes: ${report.companiesNotReady}.`
            : "")
      )
    }
  } catch {
    console.error("✗ Preflight KO — erreur technique (détails masqués).")
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()
