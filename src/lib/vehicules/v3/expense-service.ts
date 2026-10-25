import { Prisma, type VehicleExpense, type ExpenseReport } from "@prisma/client"
import { MileageDomainError } from "../mileage-domain"
import { requireMileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { normalizeMileageFailure, type MileageServiceDeps } from "../mileage-service"
import { assertAllocationTotal, expenseEnabled, expenseHash, parseExpenseCommand } from "./expense-domain"
export type ExpenseDeps = MileageServiceDeps & {
  validateDocumentVersion?: (tx: Prisma.TransactionClient, scope: { companyId: string; truckId: string; versionId: string }) => Promise<boolean>
}
type Tx = Prisma.TransactionClient
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 }
export function expenseGate() { if (!expenseEnabled()) throw new MileageDomainError("NOT_FOUND", 404) }
export const expenseJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value))
export const expenseDto = (e: VehicleExpense) => ({ ...e, amount: e.amount.toFixed(2), litres: e.litres?.toFixed(3) ?? null, occurredAt: e.occurredAt.toISOString(), createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString() })
type ExpenseSource=Pick<ExpenseReport,"id"|"companyId"|"status"|"amount"|"updatedAt">
function sourceState(e:VehicleExpense,source:ExpenseSource|null){
 if(!e.sourceExpenseReportId)return {eligible:true,warning:null,source:null}
 const snapshot=e.sourceSnapshot as {currency?:string;updatedAt?:string}|null
 const eligible=!!source&&source.companyId===e.companyId&&source.status==="APPROVED"&&Number.isFinite(source.amount)&&new Prisma.Decimal(source.amount.toString()).eq(e.amount)&&snapshot?.currency===e.currency&&snapshot?.updatedAt===source.updatedAt.toISOString()
 return {eligible,warning:!source?"SOURCE_MISSING":!eligible?"SOURCE_RECONCILIATION_REQUIRED":null,source}
}
export async function expenseSourceState(tx:Tx,e:VehicleExpense,lock=false){
 if(!e.sourceExpenseReportId)return sourceState(e,null)
 if(lock)await tx.$queryRaw`SELECT "id" FROM "expense_reports" WHERE "id"=${e.sourceExpenseReportId} AND "companyId"=${e.companyId} FOR SHARE`
 return sourceState(e,await tx.expenseReport.findFirst({where:{id:e.sourceExpenseReportId,companyId:e.companyId}}))
}
/** Bounded IN batches, never a source query for each expense in a report/list. */
export async function expenseSourceStates(tx:Tx,companyId:string,expenses:VehicleExpense[]){
 const ids=[...new Set(expenses.map(e=>e.sourceExpenseReportId).filter((id):id is string=>!!id))]
 const sources=new Map<string,ExpenseSource>()
 for(let start=0;start<ids.length;start+=500){const rows=await tx.expenseReport.findMany({where:{companyId,id:{in:ids.slice(start,start+500)}},select:{id:true,companyId:true,status:true,amount:true,updatedAt:true}});for(const row of rows)sources.set(row.id,row)}
 return new Map(expenses.map(e=>[e.id,sourceState(e,e.sourceExpenseReportId?sources.get(e.sourceExpenseReportId)??null:null)]))
}
export async function preauthorizeExpenseWrite(truckId:string,deps:ExpenseDeps){
 expenseGate();const session=requireMileageSession(await deps.auth())
 await deps.db.$transaction(tx=>authorizeVehicleLocked(tx,truckId,session,"START"),options)
}
export async function executeExpenseCommand(truckId: string, body: unknown, key: string | null, deps: ExpenseDeps) {
  expenseGate()
  const session = requireMileageSession(await deps.auth())
  const { command, key: normalizedKey } = parseExpenseCommand(body, key)
  const hash = expenseHash(command, session.companyId, truckId, session.userId)
  try { return await deps.db.$transaction(async tx => {
    const { truck, actor } = await authorizeVehicleLocked(tx, truckId, session, command.action === "CREATE" ? "START" : "READING")
    const scope = { companyId: session.companyId, truckId }
    const prior = await tx.vehicleExpenseCommand.findFirst({ where: { ...scope, idempotencyKey: normalizedKey } })
    if (prior) {
      if (prior.requestHash !== hash) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
      return { expense: prior.after, replayed: true }
    }
    if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
    let before: VehicleExpense | null = null
    if (command.action !== "CREATE") {
      before = await tx.vehicleExpense.findFirst({ where: { ...scope, id: command.expenseId } })
      if (!before) throw new MileageDomainError("EXPENSE_NOT_FOUND", 404)
      if (before.revision !== command.expectedRevision) throw new MileageDomainError("EXPENSE_REVISION_CONFLICT", 409)
      if (before.status === "CANCELLED") throw new MileageDomainError("EXPENSE_CANCELLED", 409)
    }
    if (command.action === "CREATE" || command.action === "CORRECT") {
      if (command.data.documentVersionId && (!deps.validateDocumentVersion || !await deps.validateDocumentVersion(tx, { ...scope, versionId: command.data.documentVersionId }))) throw new MileageDomainError("DOCUMENT_VERSION_NOT_FOUND", 404)
      if (command.data.maintenanceEntryId && !await tx.vehicleMaintenanceEntry.findFirst({ where: { ...scope, id: command.data.maintenanceEntryId } })) throw new MileageDomainError("MAINTENANCE_ENTRY_NOT_FOUND", 404)
    }
    let expense: VehicleExpense
    if (command.action === "CREATE") {
      expense = await tx.vehicleExpense.create({ data: { ...scope, ...command.data, occurredAt: new Date(command.data.occurredAt), createdById: actor.id } })
    } else {
      const current = before!
      const data: Prisma.VehicleExpenseUpdateInput = { revision: { increment: 1 } }
      switch (command.action) {
        case "CORRECT": {
          const allocations = await tx.vehicleExpenseAllocation.findMany({ where: { ...scope, expenseId: current.id } })
          assertAllocationTotal(command.data.amount, allocations)
          if (current.currency !== command.data.currency && allocations.length) throw new MileageDomainError("ALLOCATIONS_CURRENCY_CONFLICT", 409)
          Object.assign(data, command.data, { litres: command.data.litres ?? null, mileageObservation: command.data.mileageObservation ?? null, supplier: command.data.supplier ?? null, reference: command.data.reference ?? null, notes: command.data.notes ?? null, occurredAt: new Date(command.data.occurredAt), status: "PENDING" })
          break
        }
        case "APPROVE": {
          if (!(await expenseSourceState(tx, current, true)).eligible) throw new MileageDomainError("SOURCE_RECONCILIATION_REQUIRED", 409)
          data.status = "APPROVED"; break
        }
        case "REJECT": data.status = "REJECTED"; break
        case "CANCEL": data.status = "CANCELLED"; break
        case "RECONCILE": {
          await tx.$queryRaw`SELECT "id" FROM "expense_reports" WHERE "id" = ${command.sourceExpenseReportId} AND "companyId" = ${session.companyId} FOR SHARE`
          const source = await tx.expenseReport.findFirst({ where: { id: command.sourceExpenseReportId, companyId: session.companyId } })
          if (!source) throw new MileageDomainError("SOURCE_NOT_FOUND", 404)
          if (!Number.isFinite(source.amount) || !new Prisma.Decimal(source.amount.toString()).eq(command.confirmedAmount) || !current.amount.eq(command.confirmedAmount) || current.currency !== command.confirmedCurrency) throw new MileageDomainError("SOURCE_AMOUNT_CURRENCY_CONFLICT", 409)
          // Aucun arrondi silencieux du Float historique : la confirmation doit être exacte.
          data.sourceExpenseReportId = source.id
          data.sourceSnapshot = expenseJson({ id: source.id, companyId: source.companyId, employeeId: source.employeeId, amount: command.confirmedAmount, currency: command.confirmedCurrency, status: source.status, date: source.date, updatedAt: source.updatedAt, confirmedById: actor.id, confirmedAt: new Date() })
          data.status = "PENDING"; break
        }
        case "ALLOCATE": {
          assertAllocationTotal(current.amount, command.allocations)
          for (const allocation of command.allocations) if (allocation.mileageTripId && !await tx.mileageTrip.findFirst({ where: { ...scope, id: allocation.mileageTripId } })) throw new MileageDomainError("TRIP_NOT_FOUND", 404)
          await tx.vehicleExpenseAllocation.deleteMany({ where: { ...scope, expenseId: current.id } })
          if (command.allocations.length) await tx.vehicleExpenseAllocation.createMany({ data: command.allocations.map(a => ({ ...scope, expenseId: current.id, ...a })) })
          break
        }
      }
      expense = await tx.vehicleExpense.update({ where: { id: current.id }, data })
    }
    const allocations = await tx.vehicleExpenseAllocation.findMany({ where: { ...scope, expenseId: expense.id } })
    const after = expenseJson({ ...expenseDto(expense), allocations })
    await tx.vehicleExpenseCommand.create({ data: { ...scope, expenseId: expense.id, actorId: actor.id, action: command.action, reason: "reason" in command ? command.reason : null, idempotencyKey: normalizedKey, requestHash: hash, before: before ? expenseJson(before) : Prisma.DbNull, after } })
    return { expense: after, replayed: false }
  }, options) } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new MileageDomainError("EXPENSE_DUPLICATE_SOURCE_OR_RECEIPT", 409)
    return normalizeMileageFailure(error)
  }
}
/** One bounded lateral query: at most ten duplicate suggestions for each of fifty rows. */
async function duplicateSuggestions(tx:Tx,companyId:string,expenses:VehicleExpense[]){
 if(!expenses.length)return new Map<string,{id:string;truckId:string;label:string}[]>()
 const requests=expenses.map(e=>{const day=new Date(e.occurredAt);day.setUTCHours(0,0,0,0);return{id:e.id,amount:e.amount.toFixed(2),currency:e.currency,from:day.toISOString(),to:new Date(day.getTime()+86400000).toISOString(),reference:e.reference||null,supplier:e.supplier||null,fingerprint:e.receiptFingerprint,documentVersionId:e.documentVersionId}})
 type Candidate={id:string;truckId:string;amount:string;currency:string;occurredAt:string;supplier:string|null;reference:string|null;matricule:string}
 const rows=await tx.$queryRaw<{expenseId:string;candidates:Candidate[]}[]>`
 SELECT r.id AS "expenseId",COALESCE(jsonb_agg(jsonb_build_object('id',d.id,'truckId',d."truckId",'amount',d.amount::text,'currency',d.currency,'occurredAt',d."occurredAt",'supplier',d.supplier,'reference',d.reference,'matricule',d.matricule) ORDER BY d."occurredAt" DESC,d.id DESC) FILTER (WHERE d.id IS NOT NULL),'[]'::jsonb) AS candidates
 FROM jsonb_to_recordset(${JSON.stringify(requests)}::jsonb) AS r(id text,amount numeric,currency text,"from" timestamptz,"to" timestamptz,reference text,supplier text,fingerprint text,"documentVersionId" text)
 LEFT JOIN LATERAL (
  SELECT e.id,e."truckId",e.amount,e.currency,e."occurredAt",e.supplier,e.reference,t.matricule
  FROM vehicle_expenses e JOIN trucks t ON t.id=e."truckId" AND t."companyId"=e."companyId"
  WHERE e."companyId"=${companyId} AND e.id<>r.id AND e.status<>'CANCELLED' AND e.amount=r.amount AND e.currency=r.currency AND e."occurredAt">=r."from" AND e."occurredAt"<r."to"
  AND ((r."documentVersionId" IS NOT NULL AND e."documentVersionId"=r."documentVersionId") OR CASE WHEN r.reference IS NOT NULL AND r.supplier IS NOT NULL THEN e.reference=r.reference AND e.supplier=r.supplier ELSE e."receiptFingerprint"=COALESCE(r.fingerprint,'__none__') END)
  ORDER BY e."occurredAt" DESC,e.id DESC LIMIT 10
 )d ON TRUE GROUP BY r.id`
 return new Map(rows.map(row=>[row.expenseId,row.candidates.map(d=>({id:d.id,truckId:d.truckId,label:`${d.occurredAt.slice(0,10)} — ${d.amount} ${d.currency} — ${d.supplier??"Fournisseur non renseigné"} ${d.reference??""} — ${d.matricule}`}))]))
}
export async function readExpenses(truckId: string, deps: ExpenseDeps, offset = 0) {
  expenseGate()
  const session = requireMileageSession(await deps.auth())
  return deps.db.$transaction(async tx => {
    await authorizeVehicleLocked(tx, truckId, session, "READING") // coûts détaillés réservés aux administrateurs
    const scope = { companyId: session.companyId, truckId }
    const rows = await tx.vehicleExpense.findMany({ where: scope, take: 51, skip: offset, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], include: { allocations: true, commands: { orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 20 } } })
    const page=rows.slice(0,50),sourceStates=await expenseSourceStates(tx,session.companyId,page)
    const tripSelect={id:true,worksiteNameSnapshot:true,endEntryId:true,startEntry:{select:{occurredAt:true,recordedAt:true}}} as const
    const recentTrips=await tx.mileageTrip.findMany({where:scope,orderBy:[{startEntry:{occurredAt:"desc"}},{id:"desc"}],take:50,select:tripSelect})
    const tripLabel=(t:typeof recentTrips[number])=>`${(t.startEntry.occurredAt??t.startEntry.recordedAt).toISOString().slice(0,16).replace("T"," ")} UTC — ${t.worksiteNameSnapshot??"Trajet libre"} — ${t.endEntryId?"clos":"en cours"}`
    const tripLabels=new Map(recentTrips.map(t=>[t.id,tripLabel(t)]))
    const oldTripIds=[...new Set(page.flatMap(e=>e.allocations.map(a=>a.mileageTripId)).filter((id):id is string=>!!id&&!tripLabels.has(id)))]
    if(oldTripIds.length){const oldTrips=await tx.mileageTrip.findMany({where:{...scope,id:{in:oldTripIds}},select:tripSelect});for(const t of oldTrips)tripLabels.set(t.id,tripLabel(t))}

    const duplicateMap=await duplicateSuggestions(tx,session.companyId,page)
    const expenses=page.map(e=>{const source=sourceStates.get(e.id)!;return { ...expenseDto(e), allocations:e.allocations.map(a=>({id:a.id,mileageTripId:a.mileageTripId,amount:a.amount.toFixed(2),label:a.mileageTripId?tripLabels.get(a.mileageTripId)??"Ancien trajet":"Véhicule (sans trajet précis)"})), sourceEligible:source.eligible,sourceWarning:source.warning,duplicateCandidates:duplicateMap.get(e.id)??[] }})
    const sourceCandidates = await tx.expenseReport.findMany({ where: { companyId: session.companyId, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, date: true, amount: true, description: true, status: true }, orderBy: [{ date: "desc" }, { id: "desc" }], take: 50 })
    return { expenses, tripCandidates:recentTrips.map(t=>({id:t.id,label:tripLabel(t)})), sourceCandidates: sourceCandidates.map(s => ({ ...s, date: s.date.toISOString(), amount: s.amount.toString(), currency: null })), nextOffset: rows.length > 50 ? offset + 50 : null }
  }, options)
}
