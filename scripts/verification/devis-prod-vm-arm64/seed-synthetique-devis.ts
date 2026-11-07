/**
 * Planificator V2 — données SYNTHÉTIQUES du contrôle applicatif devis-v2 (06/11/2026). PRÉPARÉ, NON EXÉCUTÉ.
 * Lancé seulement par phase-devis-prod-vm-arm64.sh, après `prisma migrate deploy` et `prisma db seed` sur la base NEUVE
 * « controle_devis » du cluster créé par initdb dans le confinement sans réseau :
 *   DEVIS_IDS_FILE=<preuves>/devis-synthetique.json npx tsx scripts/verification/devis-prod-vm-arm64/seed-synthetique-devis.ts
 *
 * Toutes les données sont FICTIVES (noms, sociétés et adresses inventés, domaine réservé « .example »). Les devis passent par
 * les services du lot (createQuote, sendQuote avec destinataire confirmé, acceptQuoteManually) ; le client, le chantier et la
 * consultation d'origine (message + brouillon d'import, comme une demande reçue) sont créés directement.
 * Gardes PARTIELLES (le harnais prouve l'isolation) : hôte de boucle locale ; base au stade du seed initial (une seule
 * entreprise « entreprise-test », aucun devis, aucune facture, aucun message d'acquisition) ; arrêt au premier échec.
 * Aucun courrier réel : sans BILLING_MAIL_ENABLED, l'envoi est journalisé « simulé ».
 */
import { writeFileSync } from "node:fs"
import { PrismaClient } from "@prisma/client"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"

type R<T> = { ok: true; value: T } | { ok: false; error: string }
function step<T>(label: string, r: R<T>): T {
  if (!r.ok) throw new Error(`ÉCHEC à l'étape « ${label} » : ${r.error}`)
  console.log(`ok  ${label}`)
  return r.value
}

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  const out = process.env.DEVIS_IDS_FILE ?? ""
  const host = (() => { try { return new URL(url).hostname } catch { return "" } })()
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("REFUS : DATABASE_URL hors boucle locale")
  if (!out) throw new Error("REFUS : DEVIS_IDS_FILE absent")
  const db = new PrismaClient()
  try {
    const companies = await db.company.findMany({ select: { id: true, slug: true } })
    if (companies.length !== 1 || companies[0].slug !== "entreprise-test") throw new Error("REFUS : base différente du seed initial (une seule entreprise « entreprise-test » attendue)")
    const [quotes, invoices, messages] = await Promise.all([db.quote.count(), db.invoice.count(), db.acquisitionMessage.count()])
    if (quotes + invoices + messages !== 0) throw new Error("REFUS : devis, factures ou messages déjà présents (base déjà utilisée)")
    const companyId = companies[0].id
    const admin = await db.user.findFirst({ where: { companyId, email: "admin@entreprise-test.local" }, select: { id: true } })
    if (!admin) throw new Error("REFUS : administrateur du seed introuvable")
    const ctx = { companyId, userId: admin.id }
    const now = new Date()

    const client = await db.client.create({ data: { companyId, name: "Atelier Fictif SAS", email: "compta@atelier-fictif.example", address: "1 rue de l'Exemple, 75000 Paris" }, select: { id: true } })
    const worksite = await db.worksite.create({ data: { companyId, clientId: client.id, createdById: admin.id, name: "Réaménagement atelier (fictif)" }, select: { id: true } })
    console.log("ok  client et chantier fictifs")
    // Consultation d'origine : reçue d'une plateforme (expéditeur technique), demandeur extrait = « Camille Exemple ».
    const msg = await db.acquisitionMessage.create({ data: { companyId, source: "GMAIL", externalMessageId: "synthetique-devis-1", senderEmail: "noreply@plateforme-fictive.example", senderDomain: "plateforme-fictive.example", subject: "Demande de devis (fictive)", receivedAt: now } })
    await db.worksiteImportDraft.create({ data: { companyId, acquisitionMessageId: msg.id, proposedContactName: "Camille Exemple", proposedContactEmail: "camille.exemple@atelier-fictif.example", createdWorksiteId: worksite.id } })
    console.log("ok  consultation d'origine fictive")

    const today = now.toISOString().slice(0, 10)
    const until = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10)
    const form = (subject: string) => { const r = parseQuoteForm({ worksiteId: worksite.id, issueDate: today, validUntil: until, subject, globalDiscount: "2,5", lines: [{ designation: "Pose de cloisons", quantity: "12", unitPrice: "85", discount: "5", vatRate: "20" }, { designation: "Fournitures", quantity: "1", unitPrice: "420", vatRate: "20" }] }); if (!r.ok) throw new Error(r.error); return r.value }
    const draft = step("devis brouillon (dialogue d'envoi)", await createQuote(db, ctx, form("Cloisons atelier — brouillon")))
    const accepted = step("devis à facturer", await createQuote(db, ctx, form("Cloisons atelier — accepté")))
    step("envoi confirmé (courrier simulé)", await sendQuote(db, ctx, accepted.id, now, undefined, { name: "Camille Exemple", email: "camille.exemple@atelier-fictif.example", source: "CONSULTATION" }))
    step("acceptation enregistrée", await acceptQuoteManually(db, ctx, accepted.id, now))
    writeFileSync(out, JSON.stringify({ draftQuoteId: draft.id, draftQuoteNumber: draft.number, acceptedQuoteId: accepted.id, acceptedQuoteNumber: accepted.number, expectedContact: { name: "Camille Exemple", email: "camille.exemple@atelier-fictif.example" } }, null, 2))
    console.log(`ok  identifiants écrits dans ${out}`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1) })
