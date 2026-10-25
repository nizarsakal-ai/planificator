import { MileageDomainError } from "../mileage-domain"
import { assertMutationOrigin } from "../request-origin"
import { executeExpenseCommand, readExpenses, preauthorizeExpenseWrite, type ExpenseDeps } from "./expense-service"
import { readVehicleCosts,readTripCosts } from "./cost-service"
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" }
function failure(error: unknown) {
  return Response.json({ code: error instanceof MileageDomainError ? error.code : "SERVER_ERROR", error: "Opération de dépenses refusée" }, { status: error instanceof MileageDomainError ? error.status : 500, headers })
}
export function assertExpenseRequest(request: Request) {
  // Même admission d'origine que les autres mutations véhicules (inclut PLANIFICATOR_TRUSTED_ORIGINS,
  // ex. application mobile) ; les en-têtes de transfert ne donnent jamais d'autorité.
  assertMutationOrigin(request, "INVALID_ORIGIN")
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new MileageDomainError("INVALID_CONTENT_TYPE", 415)
  const length = request.headers.get("Content-Length")
  if (length!==null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 32768)) throw new MileageDomainError("PAYLOAD_TOO_LARGE", 413)
}
async function body(request: Request) {
 if(!request.body)throw new MileageDomainError("INVALID_JSON",400)
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0,complete=false,timer:ReturnType<typeof setTimeout>|undefined
 const declared=request.headers.get("Content-Length"),expected=declared===null?null:Number(declared)
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new MileageDomainError("BODY_TIMEOUT",408)),10000)})
 try{
  for(;;){const next=await Promise.race([reader.read(),deadline]);if(next.done){complete=true;break}size+=next.value.byteLength
   if(size>32768)throw new MileageDomainError("PAYLOAD_TOO_LARGE",413)
   if(expected!==null&&size>expected)throw new MileageDomainError("CONTENT_LENGTH_MISMATCH",400)
   chunks.push(next.value)
  }
  if(expected!==null&&size!==expected)throw new MileageDomainError("CONTENT_LENGTH_MISMATCH",400)
  try{return JSON.parse(Buffer.concat(chunks,size).toString("utf8")) as unknown}catch{throw new MileageDomainError("INVALID_JSON",400)}
 }finally{if(timer)clearTimeout(timer);if(!complete)void reader.cancel().catch(()=>undefined);reader.releaseLock()}
}
export async function expenseGet(request: Request, truckId: string, deps: ExpenseDeps) {
  try {
    const raw = new URL(request.url).searchParams.get("offset") ?? "0"
    if (!/^\d{1,7}$/.test(raw)) throw new MileageDomainError("INVALID_PAGE", 400)
    return Response.json(await readExpenses(truckId, deps, Number(raw)), { headers })
  } catch (e) { return failure(e) }
}
export async function expensePost(request: Request, truckId: string, deps: ExpenseDeps) {
  try {
    assertExpenseRequest(request)
    await preauthorizeExpenseWrite(truckId,deps)
    const result = await executeExpenseCommand(truckId, await body(request), request.headers.get("Idempotency-Key"), deps)
    return Response.json(result.expense, { status: result.replayed ? 200 : 201, headers: { ...headers, "Idempotency-Replayed": String(result.replayed) } })
  } catch (e) { return failure(e) }
}
export async function costGet(request: Request, truckId: string, deps: ExpenseDeps) {
  try {
    const params = new URL(request.url).searchParams
    const tripId=params.get("tripId");if(tripId)return Response.json(await readTripCosts(truckId,tripId,params.get("currency"),deps),{headers})
    return Response.json(await readVehicleCosts(truckId, { from: params.get("from"), to: params.get("to"), currency: params.get("currency") }, deps), { headers })
  } catch (e) { return failure(e) }
}
