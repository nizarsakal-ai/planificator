/**
 * Données fictives pour l'essai manuel du menu client sur la base jetable (lancé par client-delete-run.ts « seed »).
 * Refuse de s'exécuter hors du lanceur (CLIENT_DELETE_RUNNER=1) : jamais sur une base existante.
 *
 * Comptes locaux (mot de passe commun, dev uniquement, même convention que prisma/seed.ts) :
 *   admin@client-delete.local  (ADMIN)        — voit Supprimer
 *   chef@client-delete.local   (TEAM_LEADER)  — ne voit pas Supprimer
 *   portail@client-delete.local (CLIENT)      — compte portail rattaché au client « avec accès portail »
 *   Mot de passe : ClientDelete123!
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

export const SEED_PASSWORD = "ClientDelete123!"
export const SEED_COMPANY_SLUG = "client-delete-disposable"

async function main() {
  if (process.env.CLIENT_DELETE_RUNNER !== "1") {
    console.error("[client-delete-seed] REFUS — à lancer via client-delete-run.ts seed")
    process.exit(2)
  }
  const prisma = new PrismaClient()
  try {
    const hash = await bcrypt.hash(SEED_PASSWORD, 10)
    const company = await prisma.company.upsert({
      where: { slug: SEED_COMPANY_SLUG },
      update: {},
      create: { name: "Entreprise jetable (suppression clients)", slug: SEED_COMPANY_SLUG },
    })
    const other = await prisma.company.upsert({
      where: { slug: `${SEED_COMPANY_SLUG}-autre` },
      update: {},
      create: { name: "Autre entreprise (isolation)", slug: `${SEED_COMPANY_SLUG}-autre` },
    })
    const admin = await prisma.user.upsert({
      where: { email: "admin@client-delete.local" },
      update: {},
      create: { email: "admin@client-delete.local", name: "Admin Jetable", password: hash, role: "ADMIN", companyId: company.id },
    })
    await prisma.user.upsert({
      where: { email: "chef@client-delete.local" },
      update: {},
      create: { email: "chef@client-delete.local", name: "Chef Jetable", password: hash, role: "TEAM_LEADER", companyId: company.id },
    })

    const mk = (name: string, active = true) =>
      prisma.client.create({ data: { name, companyId: company.id, active, email: `${name.toLowerCase().replace(/[^a-z]+/g, "-")}@fictif.local` } })
    const libre = await mk("Client libre (supprimable)")
    const inactif = await mk("Client inactif (supprimable)", false)
    const avecChantier = await mk("Client avec chantier (bloqué)")
    const avecDevis = await mk("Client avec devis (bloqué)")
    const chantier = await prisma.worksite.create({
      data: { name: "Chantier fictif", clientId: avecChantier.id, companyId: company.id, createdById: admin.id },
    })
    const chantierDevis = await prisma.worksite.create({
      data: { name: "Chantier du devis", clientId: avecDevis.id, companyId: company.id, createdById: admin.id },
    })
    await prisma.quote.create({
      data: { companyId: company.id, worksiteId: chantierDevis.id, clientId: avecDevis.id, number: "DEV-FICTIF-0001", createdById: admin.id },
    })
    const avecPortail = await mk("Client avec accès portail (bloqué)")
    const portalUser = await prisma.user.upsert({
      where: { email: "portail@client-delete.local" },
      update: {},
      create: { email: "portail@client-delete.local", name: "Portail Jetable", password: hash, role: "CLIENT", companyId: company.id },
    })
    await prisma.clientProfile.create({ data: { clientId: avecPortail.id, userId: portalUser.id } })
    // Deux homonymes « HALL EXPO » : seul le premier est pointé par un partenaire d'acquisition (identité par id, jamais par nom)
    const hallExpo1 = await prisma.client.create({ data: { name: "HALL EXPO", companyId: company.id, email: "contact@hall-expo.fictif.local", address: "Zone fictive, Brignais" } })
    const hallExpo2 = await prisma.client.create({ data: { name: "HALL EXPO", companyId: company.id, active: false } })
    await prisma.acquisitionPartner.create({
      data: { companyId: company.id, name: "Hall Expo (partenaire)", code: "hall-expo", clientId: hallExpo1.id },
    })
    await prisma.client.create({ data: { name: "Client d'une autre entreprise", companyId: other.id } })

    console.log(`[client-delete-seed] entreprise ${company.slug} ; clients : ${[libre, inactif, avecChantier, avecDevis, avecPortail, hallExpo1, hallExpo2].map((c) => c.name).join(" | ")} ; chantier ${chantier.name}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("[client-delete-seed] ERREUR —", err instanceof Error ? err.message : String(err))
  process.exit(1)
})
