import assert from "node:assert/strict";
import { test } from "node:test";
import { handleTours } from "../../../src/lib/vehicules/v3/tour-api";
import { tourParse, createTourSchema, tourCommandSchema } from "../../../src/lib/vehicules/v3/tour-domain";
const deps = { auth: async () => null, db: { $transaction: async () => { throw new Error("must not write"); } } } as never;
const valid = { title: "Test", startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z", teamId: null, chauffeurId: null, stops: [{ label: "Test", address: "10 rue de Paris", addressValidated: true }] };
test("Tour mutation requires same-origin JSON, all error DTOs are private", async () => { for (const origin of [undefined, "https://evil.invalid"]) {
    const r = await handleTours(new Request("https://example.test/api/trucks/1/tours", { method: "POST", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, body: "{}" }), "1", undefined, deps);
    assert.equal(r.status, 403);
    assert.equal(r.headers.get("cache-control"), "private, no-store");
} });
test("Tour validation requires human-confirmed addresses, exclusive approved import and bounded interval", () => { assert.ok(tourParse(createTourSchema, valid)); assert.throws(() => tourParse(createTourSchema, { ...valid, stops: [{ ...valid.stops[0], addressValidated: false }] })); assert.throws(() => tourParse(createTourSchema, { ...valid, endsAt: valid.startsAt })); assert.throws(() => tourParse(createTourSchema, { ...valid, approvedImportId: "i", approvedImportRevision: 1 })); assert.ok(tourParse(createTourSchema, { ...valid, stops: [], approvedImportId: "i", approvedImportRevision: 1 })); assert.throws(() => tourParse(createTourSchema, { ...valid, stops: [], approvedImportId: "i" })); });
test("Anonymous writes never consume body, and lying Content-Length cannot exceed bound",async()=>{process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true";const {MileageMemoryDb,TRUCK}=await import("../mileage-test-db");let reads=0;const anonymous=new Request("https://example.test/api/trucks/x/tours",{method:"POST",headers:{origin:"https://example.test","content-type":"application/json"},body:"{}"});Object.defineProperty(anonymous,"body",{get(){reads++;throw new Error("Must not read body")}});const denied=await handleTours(anonymous,"x",undefined,deps);assert.equal(denied.status,401);assert.equal(reads,0);const db=new MileageMemoryDb();for(const length of [undefined,"2"]){const request=new Request("https://example.test/api/trucks/x/tours",{method:"POST",headers:{origin:"https://example.test","content-type":"application/json",...(length?{"content-length":length}:{})},body:" ".repeat(100001)});const response=await handleTours(request,TRUCK,undefined,db.deps());assert.equal(response.status,413);assert.equal((await response.json()).code,"PAYLOAD_TOO_LARGE")}})

test("tour origin accepts public Host with localhost internal URL but refuses foreign origins and forwarded spoofing",async()=>{
 const prior=process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;process.env.PLANIFICATOR_VEHICLES_V3_ENABLED="true"
 const make=(headers:Record<string,string>)=>new Request("http://localhost:3101/api/trucks/t/tours",{method:"POST",headers:{host:"127.0.0.1:3101",origin:"http://127.0.0.1:3101","content-type":"application/json",...headers},body:"{}"})
 try{
  assert.equal((await handleTours(make({}),"t",undefined,deps)).status,401)
  const invalidOrigins:Record<string,string>[]=[{origin:"http://localhost:3101"},{origin:"https://127.0.0.1:3101"},{origin:"http://evil.test"},{origin:"http://evil.test","x-forwarded-host":"evil.test","sec-fetch-site":"same-origin"},{"sec-fetch-site":"cross-site"},{host:"127.0.0.1:3101,evil.test"}];for(const headers of invalidOrigins){const response=await handleTours(make(headers),"t",undefined,deps);assert.equal(response.status,403);assert.equal((await response.json()).code,"INVALID_ORIGIN")}
 }finally{if(prior===undefined)delete process.env.PLANIFICATOR_VEHICLES_V3_ENABLED;else process.env.PLANIFICATOR_VEHICLES_V3_ENABLED=prior}
})

test("Non-visited stop requires an explicit bounded reason and stop identity", () => {
 const skip = { type: "SKIP", expectedRevision: 2, stopId: "stop-1", reason: "  Client absent  " };
 assert.deepEqual(tourParse(tourCommandSchema, skip), { ...skip, reason: "Client absent" });
 for (const patch of [{ reason: " " }, { reason: "x".repeat(2001) }, { stopId: "" }, { completedAt: "2026-01-01" }])
  assert.throws(() => tourParse(tourCommandSchema, { ...skip, ...patch }), /INVALID_PAYLOAD/);
});
