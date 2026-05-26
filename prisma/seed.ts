/**
 * prisma/seed.ts
 * Seed de départ — Planificator V1
 *
 * Crée :
 *   - 1 Super Admin
 *   - 1 Entreprise Test + CompanySettings
 *   - 1 Admin Entreprise (avec profil Employee)
 *   - 1 Chef d'équipe (avec profil Employee)
 *   - 2 Employés (avec profil Employee)
 *   - 1 Équipe Alpha (chef + 3 membres)
 *   - 1 Client Test (avec accès portail)
 *
 * Identifiants :
 *   superadmin@planificator.local  /  Admin123!
 *   admin@entreprise-test.local    /  Admin123!
 *   chef@entreprise-test.local     /  Admin123!
 *   marie@entreprise-test.local    /  Admin123!
 *   thomas@entreprise-test.local   /  Admin123!
 *   client@test.local              /  Admin123!
 */

import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

async function main() {
  console.log("🌱 Démarrage du seed Planificator...")

  const PASSWORD_HASH = await bcrypt.hash("Admin123!", 12)

  // ── 1. SUPER ADMIN ──────────────────────────────────────────────────────────

  const superAdmin = await prisma.user.upsert({
    where: { email: "superadmin@planificator.local" },
    update: {},
    create: {
      email: "superadmin@planificator.local",
      name: "Super Admin",
      password: PASSWORD_HASH,
      role: "SUPER_ADMIN",
    },
  })
  console.log("✅ Super Admin :", superAdmin.email)

  // ── 2. ENTREPRISE TEST ──────────────────────────────────────────────────────

  const company = await prisma.company.upsert({
    where: { slug: "entreprise-test" },
    update: {},
    create: {
      name: "Entreprise Test",
      slug: "entreprise-test",
      email: "contact@entreprise-test.local",
      phone: "01 23 45 67 89",
      address: "12 rue des Artisans, 75001 Paris",
    },
  })
  console.log("✅ Entreprise :", company.name)

  // Paramètres entreprise
  await prisma.companySettings.upsert({
    where: { companyId: company.id },
    update: {},
    create: {
      companyId: company.id,
      defaultDailyHours: 10,
      archiveDelayHours: 48,
      invitationExpiryHours: 24,
      timezone: "Europe/Paris",
      primaryColor: "#0f3460",
    },
  })

  // ── 3. ADMIN ENTREPRISE ─────────────────────────────────────────────────────

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@entreprise-test.local" },
    update: {},
    create: {
      email: "admin@entreprise-test.local",
      name: "Admin Entreprise",
      password: PASSWORD_HASH,
      role: "ADMIN",
      companyId: company.id,
    },
  })

  const adminEmployee = await prisma.employee.upsert({
    where: { userId: adminUser.id },
    update: {},
    create: {
      userId: adminUser.id,
      companyId: company.id,
      firstName: "Admin",
      lastName: "Entreprise",
      jobTitle: "Administrateur",
    },
  })
  console.log("✅ Admin :", adminUser.email)

  // ── 4. CHEF D'ÉQUIPE ────────────────────────────────────────────────────────

  const chefUser = await prisma.user.upsert({
    where: { email: "chef@entreprise-test.local" },
    update: {},
    create: {
      email: "chef@entreprise-test.local",
      name: "Jean Dupont",
      password: PASSWORD_HASH,
      role: "TEAM_LEADER",
      companyId: company.id,
    },
  })

  const chefEmployee = await prisma.employee.upsert({
    where: { userId: chefUser.id },
    update: {},
    create: {
      userId: chefUser.id,
      companyId: company.id,
      firstName: "Jean",
      lastName: "Dupont",
      jobTitle: "Chef d'équipe",
    },
  })
  console.log("✅ Chef d'équipe :", chefUser.email)

  // ── 5. EMPLOYÉS ──────────────────────────────────────────────────────────────

  const marieUser = await prisma.user.upsert({
    where: { email: "marie@entreprise-test.local" },
    update: {},
    create: {
      email: "marie@entreprise-test.local",
      name: "Marie Martin",
      password: PASSWORD_HASH,
      role: "EMPLOYEE",
      companyId: company.id,
    },
  })

  const marieEmployee = await prisma.employee.upsert({
    where: { userId: marieUser.id },
    update: {},
    create: {
      userId: marieUser.id,
      companyId: company.id,
      firstName: "Marie",
      lastName: "Martin",
      jobTitle: "Technicienne",
    },
  })

  const thomasUser = await prisma.user.upsert({
    where: { email: "thomas@entreprise-test.local" },
    update: {},
    create: {
      email: "thomas@entreprise-test.local",
      name: "Thomas Bernard",
      password: PASSWORD_HASH,
      role: "EMPLOYEE",
      companyId: company.id,
    },
  })

  const thomasEmployee = await prisma.employee.upsert({
    where: { userId: thomasUser.id },
    update: {},
    create: {
      userId: thomasUser.id,
      companyId: company.id,
      firstName: "Thomas",
      lastName: "Bernard",
      jobTitle: "Technicien",
    },
  })
  console.log("✅ Employés :", marieUser.email, "/", thomasUser.email)

  // ── 6. ÉQUIPE ALPHA ──────────────────────────────────────────────────────────

  const team = await prisma.team.upsert({
    where: { name_companyId: { name: "Équipe Alpha", companyId: company.id } },
    update: { leaderId: chefEmployee.id },
    create: {
      name: "Équipe Alpha",
      color: "#0f3460",
      companyId: company.id,
      leaderId: chefEmployee.id,
    },
  })

  // Membres : chef + 2 employés
  for (const empId of [chefEmployee.id, marieEmployee.id, thomasEmployee.id]) {
    await prisma.teamMember.upsert({
      where: { teamId_employeeId: { teamId: team.id, employeeId: empId } },
      update: {},
      create: { teamId: team.id, employeeId: empId },
    })
  }
  console.log("✅ Équipe :", team.name, "— 3 membres")

  // ── 7. CLIENT TEST ───────────────────────────────────────────────────────────

  // Trouver ou créer le client
  let client = await prisma.client.findFirst({
    where: { name: "Client Test", companyId: company.id },
  })

  if (!client) {
    client = await prisma.client.create({
      data: {
        name: "Client Test",
        email: "contact@client-test.local",
        phone: "06 12 34 56 78",
        address: "45 avenue de la République, 75011 Paris",
        companyId: company.id,
      },
    })
  }

  // Compte utilisateur portail client
  const clientUser = await prisma.user.upsert({
    where: { email: "client@test.local" },
    update: {},
    create: {
      email: "client@test.local",
      password: PASSWORD_HASH,
      role: "CLIENT",
      companyId: company.id,
    },
  })

  // Lien Client ↔ User
  await prisma.clientProfile.upsert({
    where: { clientId: client.id },
    update: { userId: clientUser.id },
    create: {
      clientId: client.id,
      userId: clientUser.id,
    },
  })
  console.log("✅ Client :", clientUser.email)

  // ── Résumé ──────────────────────────────────────────────────────────────────

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("🎉 Seed terminé ! Identifiants de connexion :")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("  Rôle             Email                          MDP")
  console.log("  ─────────────────────────────────────────────────────")
  console.log("  Super Admin    superadmin@planificator.local   Admin123!")
  console.log("  Admin          admin@entreprise-test.local     Admin123!")
  console.log("  Chef équipe    chef@entreprise-test.local      Admin123!")
  console.log("  Employée       marie@entreprise-test.local     Admin123!")
  console.log("  Employé        thomas@entreprise-test.local    Admin123!")
  console.log("  Client         client@test.local               Admin123!")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
}

main()
  .catch((e) => {
    console.error("❌ Erreur seed :", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
