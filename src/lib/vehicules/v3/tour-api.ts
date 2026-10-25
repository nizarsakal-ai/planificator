import { assertMutationOrigin } from "../request-origin";
import { MileageDomainError } from "../mileage-domain";
import { requireMileageSession } from "../mileage-access";
import { authorizeVehicleLocked } from "../vehicle-authority";
import { tourFlag } from "./tour-domain";
import type { TourServiceDeps } from "./tour-service";
import { commandTour, createTour, readTours } from "./tour-service";
const headers = { "Cache-Control": "private, no-store" };
export async function handleTours(request: Request, truckId: string, tourId: string | undefined, deps: TourServiceDeps) {
    try {
        if (request.method === "GET")
            return Response.json(await readTours(truckId, deps), { headers });
        assertMutationOrigin(request);
        if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
            throw new MileageDomainError("INVALID_CONTENT_TYPE", 415);
        tourFlag();
        const session = requireMileageSession(await deps.auth());
        await deps.db.$transaction(tx => authorizeVehicleLocked(tx, truckId, session, tourId ? "READ" : "READING"));
        const text = await readTourJsonBounded(request);
        let body: unknown;
        try {
            body = JSON.parse(text);
        }
        catch {
            throw new MileageDomainError("INVALID_JSON", 400);
        }
        const result = tourId ? await commandTour(truckId, tourId, body, request.headers.get("Idempotency-Key"), deps) : await createTour(truckId, body, request.headers.get("Idempotency-Key"), deps);
        return Response.json(result, { status: tourId ? 200 : 201, headers: { ...headers, "Idempotency-Replayed": String(result.replayed) } });
    }
    catch (e) {
        return Response.json({ code: e instanceof MileageDomainError ? e.code : "SERVER_ERROR", error: "Opération de tournée refusée" }, { status: e instanceof MileageDomainError ? e.status : 500, headers });
    }
}

const MAX_TOUR_JSON_BYTES = 100_000;
async function readTourJsonBounded(request: Request): Promise<string> {
    const length = request.headers.get("content-length");
    if (length && Number(length) > MAX_TOUR_JSON_BYTES) throw new MileageDomainError("PAYLOAD_TOO_LARGE",413);
    if (!request.body) throw new MileageDomainError("INVALID_JSON",400);
    const reader=request.body.getReader(), decoder=new TextDecoder("utf-8",{fatal:true});
    let bytes=0, text="";
    try {
        while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_TOUR_JSON_BYTES){await reader.cancel();throw new MileageDomainError("PAYLOAD_TOO_LARGE",413)}text+=decoder.decode(value,{stream:true})}
        return text+decoder.decode();
    } catch(error) {if(error instanceof MileageDomainError)throw error;throw new MileageDomainError("INVALID_JSON",400)}
    finally {reader.releaseLock()}
}
