/**
 * Initialise l'historique des affectations camion (TruckAssignment) avec
 * l'état actuel de chaque camion (chauffeur + équipe). À lancer UNE FOIS
 * après `prisma db push`, sinon l'historique ne démarre qu'au premier
 * changement d'affectation.
 *
 * Usage : DATABASE_URL="..." npx tsx scripts/init-truck-history.ts
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
  const trucks = await prisma.truck.findMany({
    select: { id: true, matricule: true, chauffeurId: true, teamId: true, companyId: true },
  })

  let created = 0
  for (const t of trucks) {
    const open = await prisma.truckAssignment.findFirst({
      where: { truckId: t.id, endedAt: null },
      select: { id: true },
    })
    if (open) continue // déjà initialisé
    await prisma.truckAssignment.create({
      data: {
        truckId: t.id,
        chauffeurId: t.chauffeurId,
        teamId: t.teamId,
        companyId: t.companyId,
      },
    })
    created++
    console.log(`✓ ${t.matricule} : période initiale créée`)
  }
  console.log(`Terminé : ${created} période(s) créée(s), ${trucks.length - created} déjà à jour.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
