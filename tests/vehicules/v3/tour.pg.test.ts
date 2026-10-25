import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { fixture } from "../pg/fixtures";
import { createTour, commandTour, readTours } from "../../../src/lib/vehicules/v3/tour-service";
import { executeMileageCommand } from "../../../src/lib/vehicules/mileage-service";
const url = process.env.TOURS_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).port !== "55433" || new URL(url).pathname !== "/v3_tours_test")
    throw new Error("Only disposable local v3_tours_test accepted");
const db = new PrismaClient({ datasources: { db: { url } } });
process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true";
test("Tour lifecycle is atomic, idempotent, ordered, isolated and reflects V2 corrections", async () => {
    try {
        const f = await fixture(db);
        const deps = f.deps();
        const body = { title: "Livraisons", startsAt: "2026-11-01T08:00:00+01:00", endsAt: "2026-11-01T18:00:00+01:00", teamId: null, chauffeurId: null, estimatedKm: 80, stops: [{ label: "Dépôt", address: "10 rue des Lilas, Paris", addressValidated: true }, { label: "Retour", address: "20 rue des Fleurs, Paris", addressValidated: true }] };
        const key = randomUUID();
        const created = await createTour(f.truck.id, body, key, deps);
        assert.equal((await createTour(f.truck.id, body, key, deps)).replayed, true);
        await assert.rejects(createTour(f.truck.id, { ...body, title: "autre" }, randomUUID(), deps), /TOUR_RESOURCE_CONFLICT/);
        await assert.rejects(db.truck.update({ where: { id: f.truck.id }, data: { active: false, archivedAt: new Date() } }), /TRUCK_HAS_ACTIVE_TOUR/);
        await assert.rejects(commandTour(f.truck.id, created.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 1, mileage: 100 }, randomUUID(), deps), /MILEAGE_REVISION_CONFLICT/);
        assert.equal((await db.vehicleTour.findUniqueOrThrow({ where: { id: created.id } })).status, "PLANNED");
        assert.equal(await db.mileageEntry.count({ where: { truckId: f.truck.id } }), 0);
        const startKey = randomUUID();
        await commandTour(f.truck.id, created.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 100 }, startKey, deps);
        assert.equal((await commandTour(f.truck.id, created.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 100 }, startKey, deps)).replayed, true);
        let tour = (await readTours(f.truck.id, deps)).tours[0];
        assert.ok(tour.mileageTripId);
        assert.equal(await db.mileageTrip.count({ where: { truckId: f.truck.id } }), 1);
        await assert.rejects(commandTour(f.truck.id, created.id, { type: "CANCEL", expectedRevision: 2 }, randomUUID(), deps), /TOUR_CANNOT_CANCEL/);
        await assert.rejects(commandTour(f.truck.id, created.id, { type: "STOP", expectedRevision: 2, stopId: tour.stops[1].id }, randomUUID(), deps), /TOUR_STOP_ORDER_CONFLICT/);
        await assert.rejects(executeMileageCommand(f.truck.id, "END", { tripId: tour.mileageTripId, mileage: 200, expectedRevision: 1 }, randomUUID(), deps), /TRIP_MANAGED_BY_TOUR/);
        await commandTour(f.truck.id, created.id, { type: "STOP", expectedRevision: 2, stopId: tour.stops[0].id }, randomUUID(), deps);
        await commandTour(f.truck.id, created.id, { type: "SKIP", expectedRevision: 3, stopId: tour.stops[1].id, reason: "Retour prévu non nécessaire" }, randomUUID(), deps);
        await assert.rejects(commandTour(f.truck.id, created.id, { type: "COMPLETE", expectedRevision: 4, expectedMileageRevision: 1, mileage: 99 }, randomUUID(), deps), /ARRIVAL_BELOW_DEPARTURE/);
        tour = (await readTours(f.truck.id, deps)).tours[0];
        assert.equal(tour.status, "IN_PROGRESS");
        assert.equal(tour.mileageTrip?.endEntryId, null);
        await commandTour(f.truck.id, created.id, { type: "COMPLETE", expectedRevision: 4, expectedMileageRevision: 1, mileage: 200 }, randomUUID(), deps);
        tour = (await readTours(f.truck.id, deps)).tours[0];
        assert.equal(tour.actualKm, 100);
        await executeMileageCommand(f.truck.id, "CORRECTION", { entryId: tour.mileageTrip!.startEntryId, expectedEffectiveEntryId: tour.mileageTrip!.startEntryId, expectedRevision: 2, mileage: 110, reason: "Relecture" }, randomUUID(), deps);
        assert.equal((await readTours(f.truck.id, deps)).tours[0].actualKm, 90);
        await assert.rejects(readTours(f.otherTruck.id, deps), /TRUCK_NOT_FOUND/);
        const race = await Promise.allSettled([createTour(f.truck.id, { ...body, startsAt: "2026-12-01T08:00:00Z", endsAt: "2026-12-01T18:00:00Z" }, randomUUID(), deps), createTour(f.truck.id, { ...body, startsAt: "2026-12-01T08:00:00Z", endsAt: "2026-12-01T18:00:00Z" }, randomUUID(), deps)]);
        assert.equal(race.filter(x => x.status === "fulfilled").length, 1);
        const cancelled = (race.find(x => x.status === "fulfilled") as PromiseFulfilledResult<{
            id: string;
        }>).value;
        await commandTour(f.truck.id, cancelled.id, { type: "CANCEL", expectedRevision: 1 }, randomUUID(), deps);
        const replayKey = randomUUID();
        const both = await Promise.all([createTour(f.truck.id, { ...body, startsAt: "2027-01-01T08:00:00Z", endsAt: "2027-01-01T18:00:00Z" }, replayKey, deps), createTour(f.truck.id, { ...body, startsAt: "2027-01-01T08:00:00Z", endsAt: "2027-01-01T18:00:00Z" }, replayKey, deps)]);
        assert.equal(both[0].id, both[1].id);
        assert.deepEqual(both.map(x => x.replayed).sort(), [false, true]);
    }
    finally {
        await db.$disconnect();
    }
});
test("Tour resource reservation respects company timezone, planning and leader rights", async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
        const f = await fixture(db);
        await db.companySettings.create({ data: { companyId: f.company.id, timezone: "America/Los_Angeles" } });
        const leaderUser = await db.user.create({ data: { email: `${randomUUID()}@example.test`, password: "unused", role: "EMPLOYEE", companyId: f.company.id } });
        const employee = await db.employee.create({ data: { companyId: f.company.id, userId: leaderUser.id, firstName: "Chef", lastName: "Test", role: "TEAM_LEADER" } });
        const team = await db.team.create({ data: { companyId: f.company.id, name: "Equipe", leaderId: employee.id } });
        await db.truck.update({ where: { id: f.truck.id }, data: { teamId: team.id, chauffeurId: employee.id } });
        const client = await db.client.create({ data: { companyId: f.company.id, name: "Client" } });
        const site = await db.worksite.create({ data: { companyId: f.company.id, clientId: client.id, name: "Chantier", createdById: f.user.id } });
        await db.assignment.create({ data: { teamId: team.id, worksiteId: site.id, date: new Date("2026-11-01T00:00:00Z") } });
        const body = { title: "Passage", startsAt: "2026-11-02T02:00:00Z", endsAt: "2026-11-02T03:00:00Z", teamId: team.id, chauffeurId: employee.id, stops: [{ label: "Libre", address: "10 rue de Paris", addressValidated: true }] };
        await assert.rejects(createTour(f.truck.id, body, randomUUID(), f.deps()), /DAILY_TEAM_PLANNING_CONFLICT/);
        const leader = f.deps(f.session(f.company.id, leaderUser.id, "TEAM_LEADER"));
        await assert.rejects(createTour(f.truck.id, body, randomUUID(), leader), /FORBIDDEN/);
        const created = await createTour(f.truck.id, { ...body, stops: [{ ...body.stops[0], worksiteId: site.id, clientId: client.id }] }, randomUUID(), f.deps());
        const otherSite = await db.worksite.create({ data: { companyId: f.company.id, clientId: client.id, name: "Autre", createdById: f.user.id } });
        await assert.rejects(db.assignment.updateMany({ where: { teamId: team.id }, data: { worksiteId: otherSite.id } }), /DAILY_TEAM_PLANNING_CONFLICT/);
        await commandTour(f.truck.id, created.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 100 }, randomUUID(), leader);
        const tour = (await readTours(f.truck.id, leader)).tours[0];
        await commandTour(f.truck.id, tour.id, { type: "SKIP", expectedRevision: 2, stopId: tour.stops[0].id, reason: "Accès chantier fermé" }, randomUUID(), leader);
        process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "false";
        await assert.rejects(executeMileageCommand(f.truck.id, "END", { tripId: tour.mileageTripId, mileage: 150, expectedRevision: 1 }, randomUUID(), f.deps()), /TRIP_MANAGED_BY_TOUR/);
        process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true";
        assert.equal(await db.mileageEntry.count({ where: { truckId: f.truck.id } }), 1);
        await commandTour(f.truck.id, tour.id, { type: "COMPLETE", expectedRevision: 3, expectedMileageRevision: 1, mileage: 150 }, randomUUID(), leader);
    }
    finally {
        process.env.PLANIFICATOR_VEHICLES_V3_ENABLED = "true";
        await db.$disconnect();
    }
});
test("Approved imports consume inside same transaction and roll back with reservation refusal", async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
        const f = await fixture(db), deps = f.deps();
        const base = { title: "Import", startsAt: "2027-05-01T08:00:00Z", endsAt: "2027-05-01T09:00:00Z", teamId: null, chauffeurId: null };
        await createTour(f.truck.id, { ...base, stops: [{ label: "Manuel", address: "10 rue des Fleurs", addressValidated: true }] }, randomUUID(), deps);
        const marker = randomUUID();
        const importDeps = { ...deps, consumeApprovedImport: async (tx: Parameters<NonNullable<import("../../../src/lib/vehicules/v3/tour-service").TourServiceDeps["consumeApprovedImport"]>>[0]) => { await tx.client.create({ data: { companyId: f.company.id, name: marker } }); return [{ label: "Import validé", address: "20 rue de Paris", latitude: null, longitude: null }]; } };
        await assert.rejects(createTour(f.truck.id, { ...base, stops: [], approvedImportId: "approved", approvedImportRevision: 1 }, randomUUID(), importDeps), /TOUR_RESOURCE_CONFLICT/);
        assert.equal(await db.client.count({ where: { name: marker } }), 0);
        await assert.rejects(createTour(f.truck.id, { ...base, stops: [], approvedImportId: "approved", approvedImportRevision: 1 }, randomUUID(), deps), /IMPORT_NOT_CONFIGURED/);
    }
    finally {
        await db.$disconnect();
    }
});
test("Concurrent planning insert and tour reserve cannot both commit", async () => { const db = new PrismaClient({ datasources: { db: { url } } }); try {
    const f = await fixture(db);
    const employee = await db.employee.findFirstOrThrow({ where: { companyId: f.company.id, userId: f.user.id } });
    const team = await db.team.create({ data: { companyId: f.company.id, name: "Concurrence", leaderId: employee.id } });
    await db.truck.update({ where: { id: f.truck.id }, data: { teamId: team.id } });
    const client = await db.client.create({ data: { companyId: f.company.id, name: "Planning" } });
    const site = await db.worksite.create({ data: { companyId: f.company.id, clientId: client.id, name: "Autre chantier", createdById: f.user.id } });
    const body = { title: "Concurrence", startsAt: "2027-03-28T01:00:00Z", endsAt: "2027-03-28T05:00:00Z", teamId: team.id, chauffeurId: null, stops: [{ label: "Libre", address: "10 rue des Fleurs", addressValidated: true }] };
    const race = await Promise.allSettled([createTour(f.truck.id, body, randomUUID(), f.deps()), db.assignment.create({ data: { teamId: team.id, worksiteId: site.id, date: new Date("2027-03-28T00:00:00Z") } })]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    assert.match(String((race.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /DAILY_TEAM_PLANNING_CONFLICT/);
}
finally {
    await db.$disconnect();
} });
test("Failure after mileage insertion rolls back tour, trip and projection together",async()=>{const db=new PrismaClient({datasources:{db:{url}}});try{const f=await fixture(db);const deps=f.deps();const tour=await createTour(f.truck.id,{title:"Rollback",startsAt:"2027-07-01T08:00:00Z",endsAt:"2027-07-01T10:00:00Z",teamId:null,chauffeurId:null,stops:[{label:"Départ",address:"10 rue des Fleurs",addressValidated:true}]},randomUUID(),deps);const broken={...deps,db:{$transaction:async(callback:(tx:import("@prisma/client").Prisma.TransactionClient)=>Promise<unknown>)=>db.$transaction(tx=>callback(new Proxy(tx,{get(target,prop){if(prop==="vehicleTour")return new Proxy(target.vehicleTour,{get(delegate,p){return p==="update"?async()=>{throw new Error("INJECTED_AFTER_MILEAGE")}:Reflect.get(delegate,p)}});const v=Reflect.get(target,prop);return typeof v==="function"?v.bind(target):v}}))) } as never};await assert.rejects(commandTour(f.truck.id,tour.id,{type:"START",expectedRevision:1,expectedMileageRevision:0,mileage:100},randomUUID(),broken),/INJECTED_AFTER_MILEAGE/);assert.equal(await db.mileageEntry.count({where:{truckId:f.truck.id}}),0);assert.equal(await db.mileageTrip.count({where:{truckId:f.truck.id}}),0);assert.equal((await db.truck.findUniqueOrThrow({where:{id:f.truck.id}})).mileageRevision,0);assert.equal((await db.vehicleTour.findUniqueOrThrow({where:{id:tour.id}})).status,"PLANNED")}finally{await db.$disconnect()}})
test("Assignment worksite edits cannot bypass driver reservation without tour team",async()=>{const db=new PrismaClient({datasources:{db:{url}}});try{const f=await fixture(db),employee=await db.employee.findFirstOrThrow({where:{companyId:f.company.id,userId:f.user.id}}),team=await db.team.create({data:{companyId:f.company.id,name:"Equipe chantier",leaderId:employee.id}}),client=await db.client.create({data:{companyId:f.company.id,name:"Client"}}),site=await db.worksite.create({data:{companyId:f.company.id,clientId:client.id,name:"Prévu",createdById:f.user.id}}),other=await db.worksite.create({data:{companyId:f.company.id,clientId:client.id,name:"Incompatible",createdById:f.user.id}});const assignment=await db.assignment.create({data:{teamId:team.id,worksiteId:site.id,date:new Date("2027-09-01T00:00:00Z")}});await db.employeeAssignment.create({data:{assignmentId:assignment.id,employeeId:employee.id,date:assignment.date}});await createTour(f.truck.id,{title:"Chauffeur seul",startsAt:"2027-09-01T08:00:00Z",endsAt:"2027-09-01T10:00:00Z",teamId:null,chauffeurId:employee.id,stops:[{label:"Chantier",address:"10 rue des Fleurs",worksiteId:site.id,clientId:client.id,addressValidated:true}]},randomUUID(),f.deps());await assert.rejects(db.assignment.update({where:{id:assignment.id},data:{worksiteId:other.id}}),/DAILY_DRIVER_PLANNING_CONFLICT/);const tour=(await readTours(f.truck.id,f.deps())).tours[0];const foreign=await db.client.create({data:{companyId:f.otherCompany.id,name:"Externe"}});await assert.rejects(db.vehicleTourStop.update({where:{id:tour.stops[0].id},data:{clientId:foreign.id}}),/Foreign key constraint/)}finally{await db.$disconnect()}})
test("Concurrent resource deactivation wins against tour creation under row share lock",async()=>{const db=new PrismaClient({datasources:{db:{url}}});try{for(const kind of ["team","driver"] as const){const f=await fixture(db),employee=await db.employee.findFirstOrThrow({where:{companyId:f.company.id,userId:f.user.id}}),team=await db.team.create({data:{companyId:f.company.id,name:"Ressource",leaderId:employee.id}});let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>release=r),locked=new Promise<void>(r=>ready=r);const disable=db.$transaction(async tx=>{if(kind==="team")await tx.team.update({where:{id:team.id},data:{active:false}});else await tx.employee.update({where:{id:employee.id},data:{active:false}});ready();await gate});await locked;const rejection=assert.rejects(createTour(f.truck.id,{title:"Désactivation",startsAt:"2027-10-01T08:00:00Z",endsAt:"2027-10-01T10:00:00Z",teamId:kind==="team"?team.id:null,chauffeurId:kind==="driver"?employee.id:null,stops:[{label:"Adresse",address:"10 rue de Paris",addressValidated:true}]},randomUUID(),f.deps(f.session(f.company.id,f.global.id,"SUPER_ADMIN"))),kind==="team"?/TEAM_NOT_FOUND/:/DRIVER_NOT_FOUND/);await new Promise(r=>setTimeout(r,40));release();await disable;await rejection;assert.equal(await db.vehicleTour.count({where:{truckId:f.truck.id}}),0)}}finally{await db.$disconnect()}})
test("Half-open tour ending at company midnight excludes next daily planning date",async()=>{const db=new PrismaClient({datasources:{db:{url}}});try{for(const [timezone,startsAt,endsAt] of [["Europe/Paris","2027-07-05T22:00:00+02:00","2027-07-06T00:00:00+02:00"],["America/Los_Angeles","2027-07-05T22:00:00-07:00","2027-07-06T00:00:00-07:00"]]){const f=await fixture(db);await db.companySettings.create({data:{companyId:f.company.id,timezone}});const employee=await db.employee.findFirstOrThrow({where:{companyId:f.company.id,userId:f.user.id}}),team=await db.team.create({data:{companyId:f.company.id,name:"Équipe minuit",leaderId:employee.id}}),client=await db.client.create({data:{companyId:f.company.id,name:"Client"}}),site=await db.worksite.create({data:{companyId:f.company.id,clientId:client.id,name:"Mardi",createdById:f.user.id}});const assignment=await db.assignment.create({data:{teamId:team.id,worksiteId:site.id,date:new Date("2027-07-06T00:00:00Z")}});await db.employeeAssignment.create({data:{assignmentId:assignment.id,employeeId:employee.id,date:assignment.date}});const input={title:"Lundi soir",startsAt,endsAt,teamId:team.id,chauffeurId:employee.id,stops:[{label:"Libre",address:"10 rue des Fleurs",addressValidated:true}]};const tour=await createTour(f.truck.id,input,randomUUID(),f.deps());assert.ok(tour.id);await assert.rejects(db.assignment.create({data:{teamId:team.id,worksiteId:site.id,date:new Date("2027-07-05T00:00:00Z")}}),/DAILY_TEAM_PLANNING_CONFLICT/);const anotherTeam=await db.team.create({data:{companyId:f.company.id,name:"Autre équipe",leaderId:employee.id}});const monday=await db.assignment.create({data:{teamId:anotherTeam.id,worksiteId:site.id,date:new Date("2027-07-05T00:00:00Z")}});await assert.rejects(db.employeeAssignment.create({data:{assignmentId:monday.id,employeeId:employee.id,date:monday.date}}),/DAILY_DRIVER_PLANNING_CONFLICT/);await commandTour(f.truck.id,tour.id,{type:"CANCEL",expectedRevision:1},randomUUID(),f.deps());await db.assignment.create({data:{teamId:team.id,worksiteId:site.id,date:new Date("2027-07-05T00:00:00Z")}});await assert.rejects(createTour(f.truck.id,input,randomUUID(),f.deps()),/DAILY_TEAM_PLANNING_CONFLICT/)}}finally{await db.$disconnect()}})

test("Non-visited stop is ordered, audited, idempotent and closes with actual V2 mileage", async () => {
 const db = new PrismaClient({ datasources: { db: { url } } });
 try {
  const f = await fixture(db), deps = f.deps();
  const created = await createTour(f.truck.id, { title: "Livraison interrompue", startsAt: "2028-01-01T08:00:00Z", endsAt: "2028-01-01T12:00:00Z", teamId: null, chauffeurId: null, stops: [{ label: "Client absent", address: "10 rue des Lilas", addressValidated: true }, { label: "Retour dépôt", address: "20 rue des Fleurs", addressValidated: true }] }, randomUUID(), deps);
  await commandTour(f.truck.id, created.id, { type: "START", expectedRevision: 1, expectedMileageRevision: 0, mileage: 100 }, randomUUID(), deps);
  let tour = (await readTours(f.truck.id, deps)).tours[0];
  await assert.rejects(commandTour(f.truck.id, tour.id, { type: "SKIP", expectedRevision: 2, stopId: tour.stops[1].id, reason: "Client absent" }, randomUUID(), deps), /TOUR_STOP_ORDER_CONFLICT/);
  await assert.rejects(commandTour(f.truck.id, tour.id, { type: "SKIP", expectedRevision: 2, stopId: tour.stops[0].id, reason: " " }, randomUUID(), deps), /INVALID_PAYLOAD/);
  const key = randomUUID(), skip = { type: "SKIP", expectedRevision: 2, stopId: tour.stops[0].id, reason: "  Client absent  " };
  const before = new Date();
  await commandTour(f.truck.id, tour.id, skip, key, deps);
  assert.equal((await commandTour(f.truck.id, tour.id, skip, key, deps)).replayed, true);
  await assert.rejects(commandTour(f.truck.id, tour.id, { ...skip, reason: "Autre motif" }, key, deps), /IDEMPOTENCY_CONFLICT/);
  tour = (await readTours(f.truck.id, deps)).tours[0];
  assert.equal(tour.revision, 3);
  assert.equal(tour.stops[0].completedAt, null);
  assert.equal(tour.stops[0].skippedById, f.user.id);
  assert.equal(tour.stops[0].skippedReason, "Client absent");
  assert.ok(tour.stops[0].skippedAt && tour.stops[0].skippedAt >= before);
  await assert.rejects(commandTour(f.truck.id, tour.id, { type: "COMPLETE", expectedRevision: 3, expectedMileageRevision: 1, mileage: 123 }, randomUUID(), deps), /TOUR_STOPS_PENDING/);
  await assert.rejects(db.vehicleTourStop.update({ where: { id: tour.stops[0].id }, data: { completedAt: new Date() } }), /vehicle_tour_stops_skip_check/);
  await commandTour(f.truck.id, tour.id, { type: "STOP", expectedRevision: 3, stopId: tour.stops[1].id }, randomUUID(), deps);
  await commandTour(f.truck.id, tour.id, { type: "COMPLETE", expectedRevision: 4, expectedMileageRevision: 1, mileage: 123 }, randomUUID(), deps);
  tour = (await readTours(f.truck.id, deps)).tours[0];
  assert.equal(tour.status, "COMPLETED");
  assert.equal(tour.actualKm, 23);
  assert.equal(tour.stops[0].completedAt, null);
  assert.ok(tour.stops[1].completedAt);
  assert.equal(await db.mileageEntry.count({ where: { truckId: f.truck.id } }), 2);
 } finally { await db.$disconnect(); }
});
