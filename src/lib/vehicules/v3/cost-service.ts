import { MileageDomainError } from "../mileage-domain"
import { Prisma } from "@prisma/client"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { requireMileageSession } from "../mileage-access"
import { getMileageTripDistance, resolveMileageHistory } from "../mileage-domain"
import { expenseGate, expenseSourceStates, type ExpenseDeps } from "./expense-service"
import { parseCostPeriod } from "./expense-domain"
export async function readVehicleCosts(truckId: string, query: { from: string | null; to: string | null; currency: string | null }, deps: ExpenseDeps) {
  expenseGate()
  const session = requireMileageSession(await deps.auth()), period = parseCostPeriod(query.from, query.to, query.currency)
  return deps.db.$transaction(async tx => {
    await authorizeVehicleLocked(tx, truckId, session, "READING")
    const scope = { companyId: session.companyId, truckId }
    // Journal complet : conserver les chaînes de corrections V2, puis filtrer les dates originales.
    const entries = await tx.mileageEntry.findMany({ where: scope, orderBy: { revision: "asc" } })
    const trips = await tx.mileageTrip.findMany({ where: scope })
    const history = resolveMileageHistory(entries)
    let realKm = 0, closedTrips = 0, crossingTrips = 0, openTrips = 0
    for (const trip of trips) {
      const start = history.byOriginalId.get(trip.startEntryId)!.original.occurredAt
      const end = trip.endEntryId ? history.byOriginalId.get(trip.endEntryId)!.original.occurredAt : null
      if (start >= period.to || (end && end < period.from)) continue
      if (!end) { openTrips++; continue }
      if (start < period.from || end >= period.to) { crossingTrips++; continue }
      realKm += getMileageTripDistance(history, trip) ?? 0
      closedTrips++
    }
    const expenses = await tx.vehicleExpense.findMany({ where: { ...scope, occurredAt: { gte: period.from, lt: period.to } } })
    const totals: Record<string, Prisma.Decimal> = { FUEL: new Prisma.Decimal(0), MAINTENANCE: new Prisma.Decimal(0), INSURANCE: new Prisma.Decimal(0), OTHER: new Prisma.Decimal(0) }
    let fuelWithLitresAmount = new Prisma.Decimal(0), litres = new Prisma.Decimal(0), unknownLitresPurchases = 0, excludedSource = 0, excludedCurrency = 0, admittedExpenses = 0
    const sourceStates=await expenseSourceStates(tx,session.companyId,expenses.filter(e=>e.status==="APPROVED"&&e.currency===period.currency))
    for (const expense of expenses) {
      if (expense.status !== "APPROVED") continue
      if (expense.currency !== period.currency) { excludedCurrency++; continue }
      if (!sourceStates.get(expense.id)!.eligible) { excludedSource++; continue }
      totals[expense.category] = totals[expense.category].plus(expense.amount)
      admittedExpenses++
      if (expense.category === "FUEL") {
        if (expense.litres) { litres = litres.plus(expense.litres); fuelWithLitresAmount = fuelWithLitresAmount.plus(expense.amount) }
        else unknownLitresPurchases++
      }
    }
    const total = Object.values(totals).reduce((sum, v) => sum.plus(v), new Prisma.Decimal(0))
    return { truckId, period: { from: period.from.toISOString(), to: period.to.toISOString(), currency: period.currency, endExclusive: true },
      realKm, closedTrips, crossingTrips, openTrips, coverage: "CLOSED_TRIPS_FULLY_INSIDE_PERIOD_ONLY", completeVehicleMileage: false,
      admittedExpenses, excludedSource, excludedCurrency, totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toFixed(2)])), total: total.toFixed(2),
      missingCategories: Object.entries(totals).filter(([, v]) => v.isZero()).map(([k]) => k), completeCostStatus: "PARTIAL", costPerKm: realKm > 0 ? total.div(realKm).toFixed(4) : null,
      fuelPurchasesPerKm: realKm > 0 ? totals.FUEL.div(realKm).toFixed(4) : null,
      purchasedLitres: litres.toFixed(3), unknownLitresPurchases, averagePurchasePricePerLitre: litres.gt(0) ? fuelWithLitresAmount.div(litres).toFixed(4) : null,
      fuelConsumption: null, fuelConsumptionReason: "PURCHASES_ARE_NOT_CONSUMPTION",
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 })
}
export type VehicleCostsDto = Awaited<ReturnType<typeof readVehicleCosts>>

/** Costs explicitly allocated to one V2 trip, independent of purchase-date windows.
 * These amounts are projections of the register, never added to vehicle totals. */
export async function readTripCosts(truckId:string,tripId:string,currency:string|null,deps:ExpenseDeps){
 expenseGate()
 if(!tripId.trim()||tripId.length>200||!currency||!/^[A-Z]{3}$/.test(currency))throw new MileageDomainError("INVALID_TRIP_COST_QUERY",400)
 const session=requireMileageSession(await deps.auth())
 return deps.db.$transaction(async tx=>{
  await authorizeVehicleLocked(tx,truckId,session,"READING")
  const scope={companyId:session.companyId,truckId}
  const trip=await tx.mileageTrip.findFirst({where:{...scope,id:tripId},include:{startEntry:true}})
  if(!trip)throw new MileageDomainError("TRIP_NOT_FOUND",404)
  const entries=await tx.mileageEntry.findMany({where:scope,orderBy:{revision:"asc"}})
  const actualKm=getMileageTripDistance(resolveMileageHistory(entries),trip)
  const allocations=await tx.vehicleExpenseAllocation.findMany({where:{...scope,mileageTripId:tripId},include:{expense:true}})
  const sourceStates=await expenseSourceStates(tx,session.companyId,allocations.filter(a=>a.expense.status==="APPROVED"&&a.expense.currency===currency).map(a=>a.expense))
  const totals:Record<string,Prisma.Decimal>={FUEL:new Prisma.Decimal(0),MAINTENANCE:new Prisma.Decimal(0),INSURANCE:new Prisma.Decimal(0),OTHER:new Prisma.Decimal(0)}
  let excludedSource=0,excludedCurrency=0,excludedPending=0,admittedAllocations=0
  for(const allocation of allocations){const e=allocation.expense
   if(e.status!=="APPROVED"){excludedPending++;continue}
   if(e.currency!==currency){excludedCurrency++;continue}
   if(!sourceStates.get(e.id)!.eligible){excludedSource++;continue}
   totals[e.category]=totals[e.category].plus(allocation.amount);admittedAllocations++
  }
  const total=Object.values(totals).reduce((sum,value)=>sum.plus(value),new Prisma.Decimal(0))
  return {tripId,truckId,currency,label:`${(trip.startEntry.occurredAt??trip.startEntry.recordedAt).toISOString().slice(0,16).replace("T"," ")} UTC — ${trip.worksiteNameSnapshot??"Trajet libre"}`,
   actualKm,tripClosed:!!trip.endEntryId,admittedAllocations,excludedSource,excludedCurrency,excludedPending,
   totals:Object.fromEntries(Object.entries(totals).map(([key,value])=>[key,value.toFixed(2)])),total:total.toFixed(2),
   costPerKm:actualKm!==null&&actualKm>0?total.div(actualKm).toFixed(4):null,
   fuelAllocatedCostPerKm:actualKm!==null&&actualKm>0?totals.FUEL.div(actualKm).toFixed(4):null,
   unavailableReason:actualKm===null?"TRIP_OPEN_OR_DISTANCE_UNKNOWN":actualKm===0?"ZERO_DISTANCE":null,
   method:"EXPLICIT_ALLOCATIONS_TO_TRIP_ONLY",completeCostStatus:"PARTIAL",fuelConsumption:null,
  }
 },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead,maxWait:5000,timeout:15000})
}
export type TripCostsDto=Awaited<ReturnType<typeof readTripCosts>>
