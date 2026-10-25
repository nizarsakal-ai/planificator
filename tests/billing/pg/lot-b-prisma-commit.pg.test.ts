// Lot B — régression : Prisma 5.22 avale les erreurs levées au COMMIT d'une transaction interactive.
// Les invariants différés de la facturation doivent donc être évalués avant le COMMIT (flushDeferredConstraints),
// sans quoi une violation serait annulée en base mais présentée comme réussie à l'utilisateur.
// Requiert DATABASE_URL vers une base JETABLE migrée.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

const db = new PrismaClient()

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,"updatedAt") VALUES ('u','u@x','x',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','ClA',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','u','WA',now())`)
  await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,"totalHT","totalVAT","totalTTC") VALUES ('i1','coA','wA','clA','FAC-i1','u',now(),'DRAFT',100,20,120)`)
  await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('l-i1','i1','L',1,100,20,100)`)
  await db.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='i1'`)
})
after(() => db.$disconnect())

describe("Lot B — invariants différés remontés avant COMMIT", () => {
  it("sans flush : la violation est annulée en base mais la transaction paraît réussie (défaut Prisma figé)", async () => {
    await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE invoices SET status='CANCELLED' WHERE id='i1'`) })
    const row = await db.invoice.findUniqueOrThrow({ where: { id: "i1" }, select: { status: true } })
    assert.equal(row.status, "SENT")
  })
  it("avec flushDeferredConstraints : l'annulation sans avoir lève INVOICE_CANCEL_WITHOUT_CREDIT_NOTE", async () => {
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='CANCELLED' WHERE id='i1'`)
      await flushDeferredConstraints(tx)
    }), /INVOICE_CANCEL_WITHOUT_CREDIT_NOTE/)
  })
  it("chaque transaction interactive de invoice.actions.ts exécute flushDeferredConstraints", () => {
    const src = readFileSync("src/lib/actions/invoice.actions.ts", "utf8")
    const tx = src.split("prisma.$transaction(").slice(1)
    assert.equal(tx.length, 4)
    for (const body of tx) assert.match(body.split("revalidatePath(")[0], /flushDeferredConstraints\(tx\)/)
  })
})
