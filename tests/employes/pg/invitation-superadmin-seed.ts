/**
 * Données FICTIVES pour la base jetable de l'invitation supervisée (lancé par invitation-superadmin-run.ts « seed »).
 * Refuse de s'exécuter hors du lanceur (INVITATION_SUPERADMIN_RUNNER=1) : jamais sur une base existante.
 * Aucune donnée réelle : adresses en `.local`, entreprises « fictive ».
 *
 * Comptes locaux (mot de passe commun, dev uniquement) :
 *   superadmin@invitation-superadmin.local   SUPER_ADMIN rattaché à « GALYA fictive »
 *   makram.fictif@invitation-superadmin.local ADMIN historique (sans fiche employé) de « Nohisac fictive »
 *   Mot de passe : InvitationSA123!
 * Invitation PENDING préexistante : nohisac.fictif@invitation-superadmin.local → « Nohisac fictive » (preuve de purge / rollback).
 * Doublons de casse : dup@… et Dup@… (preuve d'ambiguïté refusée).
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

export const SEED_PASSWORD = "InvitationSA123!"
export const SLUGS = { galya: "invitation-superadmin-galya-fictive", nohisac: "invitation-superadmin-nohisac-fictive", inactive: "invitation-superadmin-tenant-desactive" }
export const EMAILS = {
  superAdmin: "superadmin@invitation-superadmin.local",
  makram: "makram.fictif@invitation-superadmin.local",
  pending: "nohisac.fictif@invitation-superadmin.local",
  dupLower: "dup@invitation-superadmin.local",
  dupUpper: "Dup@invitation-superadmin.local",
}

async function main() {
  if (process.env.INVITATION_SUPERADMIN_RUNNER !== "1") {
    console.error("[invitation-superadmin-seed] REFUS — à lancer via invitation-superadmin-run.ts seed")
    process.exit(2)
  }
  const prisma = new PrismaClient()
  try {
    const hash = await bcrypt.hash(SEED_PASSWORD, 10)
    const galya = await prisma.company.upsert({ where: { slug: SLUGS.galya }, update: {}, create: { name: "GALYA fictive", slug: SLUGS.galya } })
    const nohisac = await prisma.company.upsert({ where: { slug: SLUGS.nohisac }, update: {}, create: { name: "Nohisac fictive", slug: SLUGS.nohisac } })
    await prisma.company.upsert({ where: { slug: SLUGS.inactive }, update: {}, create: { name: "Tenant désactivé fictif", slug: SLUGS.inactive, active: false } })
    await prisma.user.upsert({ where: { email: EMAILS.superAdmin }, update: {}, create: { email: EMAILS.superAdmin, name: "Supervision fictive", password: hash, role: "SUPER_ADMIN", companyId: galya.id } })
    const makram = await prisma.user.upsert({ where: { email: EMAILS.makram }, update: {}, create: { email: EMAILS.makram, name: "Makram fictif", password: hash, role: "ADMIN", companyId: nohisac.id } })
    await prisma.user.upsert({ where: { email: EMAILS.dupLower }, update: {}, create: { email: EMAILS.dupLower, password: hash, role: "EMPLOYEE", companyId: galya.id } })
    await prisma.user.upsert({ where: { email: EMAILS.dupUpper }, update: {}, create: { email: EMAILS.dupUpper, password: hash, role: "EMPLOYEE", companyId: nohisac.id } })
    const existing = await prisma.invitation.findFirst({ where: { email: EMAILS.pending, companyId: nohisac.id, status: "PENDING" } })
    if (!existing) {
      await prisma.invitation.create({ data: { email: EMAILS.pending, role: "EMPLOYEE", companyId: nohisac.id, invitedById: makram.id, token: "seed-pending-token-to-be-purged", expiresAt: new Date(Date.now() + 86_400_000), status: "PENDING" } })
    }
    console.log("[invitation-superadmin-seed] données fictives en place (3 entreprises, 4 comptes, 1 invitation PENDING)")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => { console.error("[invitation-superadmin-seed] ERREUR —", err instanceof Error ? err.message : String(err)); process.exit(1) })
