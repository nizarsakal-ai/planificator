import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authorizeVehicleLocked } from "../vehicle-authority";
import { requireMileageSession } from "../mileage-access";
import { MileageDomainError, parseMileageCommand, resolveMileageHistory, getMileageTripDistance } from "../mileage-domain";
import { executeMileageCommandInTransaction, normalizeMileageFailure, type MileageServiceDeps } from "../mileage-service";
import { createTourSchema, tourStopSchema, tourCommandSchema, tourFlag, tourParse } from "./tour-domain";
export interface TourServiceDeps extends MileageServiceDeps {
    consumeApprovedImport?: (tx: Prisma.TransactionClient, scope: {
        companyId: string;
        truckId: string;
        userId: string;
        consumptionKey: string;
    }, importId: string, revision: number) => Promise<{
        label: string;
        address: string;
        latitude: number | null;
        longitude: number | null;
    }[]>;
}
const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 };
function fail(code: string, status = 409): never { throw new MileageDomainError(code, status); }
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
function keyParse(key: string | null) { const r = z.string().uuid().safeParse(key); if (!r.success)
    fail("INVALID_IDEMPOTENCY_KEY", 400); return r.data.toLowerCase(); }
// Serialize tour reservations by company before truck/authority locks. Planning row locks
// are shared with existing daily assignment constraints; no new daily assignment is created.
async function reservationLock(tx: Prisma.TransactionClient, companyId: string) { await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle-tours:${companyId}`}, 0))`; }
async function resourceCheck(tx: Prisma.TransactionClient, companyId: string, truckId: string, input: {
    teamId: string | null;
    chauffeurId: string | null;
    startsAt: Date;
    endsAt: Date;
    stops: {
        worksiteId?: string | null;
    }[];
}, excluding?: string, starting = false) {
    const ids = [input.teamId, input.chauffeurId].filter(Boolean).sort();
    for (const id of ids)
        await tx.$executeRaw `SELECT pg_advisory_xact_lock(hashtextextended(${`vehicle-resource:${companyId}:${id}`},0))`;
    const resources = [{kind:"team",id:input.teamId},{kind:"driver",id:input.chauffeurId}].filter((r):r is {kind:string;id:string}=>Boolean(r.id)).sort((a,b)=>a.id.localeCompare(b.id)||a.kind.localeCompare(b.kind));
    for (const resource of resources) {
        const rows = resource.kind === "team"
            ? await tx.$queryRaw<{id:string;active:boolean}[]>`SELECT "id", "active" FROM "teams" WHERE "id"=${resource.id} AND "companyId"=${companyId} FOR SHARE`
            : await tx.$queryRaw<{id:string;active:boolean}[]>`SELECT "id", "active" FROM "employees" WHERE "id"=${resource.id} AND "companyId"=${companyId} FOR SHARE`;
        if (!rows[0]?.active) fail(resource.kind === "team" ? "TEAM_NOT_FOUND" : "DRIVER_NOT_FOUND",404);
    }
    const reservations = await tx.vehicleTour.findMany({ where: { companyId, id: excluding ? { not: excluding } : undefined, status: { in: ["PLANNED", "IN_PROGRESS"] }, OR: [{ truckId }, ...(input.teamId ? [{ teamId: input.teamId }] : []), ...(input.chauffeurId ? [{ chauffeurId: input.chauffeurId }] : [])] } });
    if (reservations.some(t => (starting && t.status === "IN_PROGRESS") || (t.startsAt < input.endsAt && t.endsAt > input.startsAt)))
        fail("TOUR_RESOURCE_CONFLICT");
    const settings = await tx.companySettings.findUnique({ where: { companyId } });
    const businessDate = (d: Date) => new Date(new Intl.DateTimeFormat("en-CA", { timeZone: settings?.timezone || "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) + "T00:00:00Z");
    const start = businessDate(input.startsAt), end = businessDate(new Date(input.endsAt.getTime() - 1));
    const worksites = new Set(input.stops.map(x => x.worksiteId).filter(Boolean));
    if (input.teamId) {
        const assignments = await tx.assignment.findMany({ where: { teamId: input.teamId, date: { gte: start, lte: end } } });
        if (assignments.some(x => !worksites.has(x.worksiteId)))
            fail("DAILY_TEAM_PLANNING_CONFLICT");
    }
    if (input.chauffeurId) {
        const assignments = await tx.employeeAssignment.findMany({ where: { employeeId: input.chauffeurId, date: { gte: start, lte: end } }, include: { assignment: true } });
        if (assignments.some(x => !worksites.has(x.assignment.worksiteId)))
            fail("DAILY_DRIVER_PLANNING_CONFLICT");
    }
}
export async function createTour(truckId: string, body: unknown, key: string | null, deps: TourServiceDeps) {
    tourFlag();
    const input = tourParse(createTourSchema, body), k = keyParse(key), session = requireMileageSession(await deps.auth());
    const requestHash = hash(["tour-create-v1", session, truckId, input]);
    try {
        return await deps.db.$transaction(async (tx) => {
            await reservationLock(tx, session.companyId);
            const { truck, actor } = await authorizeVehicleLocked(tx, truckId, session, "READING");
            if (!truck.active)
                fail("TRUCK_ARCHIVED");
            const old = await tx.vehicleTourCommand.findUnique({ where: { companyId_truckId_key: { companyId: session.companyId, truckId, key: k } } });
            if (old) {
                if (old.requestHash !== requestHash)
                    fail("IDEMPOTENCY_CONFLICT");
                return { id: old.tourId, revision: old.acceptedRevision, replayed: true };
            }
            const tourId = randomUUID();
            let stops = input.stops;
            if (input.approvedImportId) {
                if (!deps.consumeApprovedImport)
                    fail("IMPORT_NOT_CONFIGURED", 503);
                const imported = await deps.consumeApprovedImport(tx, { companyId: session.companyId, truckId, userId: session.userId, consumptionKey: tourId }, input.approvedImportId, input.approvedImportRevision!);
                stops = tourParse(z.array(tourStopSchema).min(1).max(50), imported.map(x => ({ ...x, addressValidated: true as const })));
            }
            const parsed = { ...input, stops, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt) };
            await resourceCheck(tx, session.companyId, truckId, parsed);
            for (const stop of stops) {
                if (stop.worksiteId) {
                    const site = await tx.worksite.findFirst({ where: { id: stop.worksiteId, companyId: session.companyId, archivedAt: null } });
                    if (!site)
                        fail("WORKSITE_NOT_FOUND", 404);
                    if (stop.clientId && site.clientId !== stop.clientId)
                        fail("CLIENT_WORKSITE_MISMATCH", 400);
                }
                if (stop.clientId && !await tx.client.findFirst({ where: { id: stop.clientId, companyId: session.companyId, active: true } }))
                    fail("CLIENT_NOT_FOUND", 404);
            }
            const team = input.teamId ? await tx.team.findUnique({ where: { id: input.teamId } }) : null, driver = input.chauffeurId ? await tx.employee.findUnique({ where: { id: input.chauffeurId } }) : null;
            const tour = await tx.vehicleTour.create({ data: { id: tourId, companyId: session.companyId, truckId, title: input.title, teamId: input.teamId, chauffeurId: input.chauffeurId, teamNameSnapshot: team?.name, chauffeurNameSnapshot: driver ? `${driver.firstName} ${driver.lastName}` : null, startsAt: parsed.startsAt, endsAt: parsed.endsAt, estimatedKm: input.estimatedKm, createdById: actor.id, stops: { create: stops.map(({ addressValidated, ...stop }, position) => ({ ...stop, position, validatedById: actor.id })) } } });
            await tx.vehicleTourCommand.create({ data: { tourId: tour.id, companyId: session.companyId, truckId, key: k, requestHash, acceptedRevision: 1 } });
            return { id: tour.id, revision: 1, replayed: false };
        }, options);
    }
    catch (e) {
        return normalizeMileageFailure(e);
    }
}
export async function commandTour(truckId: string, tourId: string, body: unknown, key: string | null, deps: TourServiceDeps) {
    tourFlag();
    const command = tourParse(tourCommandSchema, body), k = keyParse(key), session = requireMileageSession(await deps.auth()), requestHash = hash(["tour-command-v1", session, truckId, tourId, command]);
    try {
        return await deps.db.$transaction(async (tx) => {
            await reservationLock(tx, session.companyId);
            const { truck } = await authorizeVehicleLocked(tx, truckId, session, command.type === "CANCEL" ? "READING" : command.type === "COMPLETE" ? "END" : "START");
            const tour = await tx.vehicleTour.findFirst({ where: { id: tourId, companyId: session.companyId, truckId }, include: { stops: { orderBy: { position: "asc" } } } });
            if (!tour)
                fail("TOUR_NOT_FOUND", 404);
            if (session.role === "TEAM_LEADER" && (tour.teamId !== truck.teamId || tour.chauffeurId !== truck.chauffeurId))
                fail("TOUR_ASSIGNMENT_CHANGED");
            const old = await tx.vehicleTourCommand.findUnique({ where: { companyId_truckId_key: { companyId: session.companyId, truckId, key: k } } });
            if (old) {
                if (old.requestHash !== requestHash)
                    fail("IDEMPOTENCY_CONFLICT");
                return { id: tour.id, revision: old.acceptedRevision, replayed: true };
            }
            if (tour.revision !== command.expectedRevision)
                fail("TOUR_REVISION_CONFLICT");
            if (!truck.active)
                fail("TRUCK_ARCHIVED");
            let data: Prisma.VehicleTourUncheckedUpdateInput = { revision: { increment: 1 } };
            if (command.type === "START") {
                if (tour.status !== "PLANNED")
                    fail("TOUR_NOT_PLANNED");
                if (tour.teamId !== truck.teamId || tour.chauffeurId !== truck.chauffeurId)
                    fail("TOUR_ASSIGNMENT_CHANGED");
                await resourceCheck(tx, session.companyId, truckId, { ...tour, stops: tour.stops }, tour.id, true);
                const result = await executeMileageCommandInTransaction(tx, truckId, parseMileageCommand("START", { mileage: command.mileage, expectedRevision: command.expectedMileageRevision, worksiteId: tour.stops[0]?.worksiteId }, k), session);
                data = { ...data, status: "IN_PROGRESS", mileageTripId: result.receipt.tripId! };
            }
            else if (command.type === "COMPLETE") {
                if (tour.status !== "IN_PROGRESS" || !tour.mileageTripId)
                    fail("TOUR_NOT_IN_PROGRESS");
                if (tour.stops.some(x => !x.completedAt && !x.skippedAt))
                    fail("TOUR_STOPS_PENDING");
                await tx.$executeRaw `SELECT set_config('planificator.tour_completion', ${tour.id}, true)`;
                await executeMileageCommandInTransaction(tx, truckId, parseMileageCommand("END", { mileage: command.mileage, expectedRevision: command.expectedMileageRevision, tripId: tour.mileageTripId }, k), session, tour.id);
                data = { ...data, status: "COMPLETED", completedAt: new Date() };
            }
            else if (command.type === "STOP" || command.type === "SKIP") {
                if (tour.status !== "IN_PROGRESS")
                    fail("TOUR_NOT_IN_PROGRESS");
                const next = tour.stops.find(x => !x.completedAt && !x.skippedAt);
                if (next?.id !== command.stopId)
                    fail("TOUR_STOP_ORDER_CONFLICT");
                await tx.vehicleTourStop.update({ where: { id: next.id }, data: command.type === "SKIP" ? { skippedAt: new Date(), skippedReason: command.reason, skippedById: session.userId } : { completedAt: new Date() } });
            }
            else {
                if (tour.status !== "PLANNED")
                    fail("TOUR_CANNOT_CANCEL");
                data = { ...data, status: "CANCELLED" };
            }
            await tx.vehicleTour.update({ where: { id: tour.id }, data });
            await tx.vehicleTourCommand.create({ data: { tourId, companyId: session.companyId, truckId, key: k, requestHash, acceptedRevision: tour.revision + 1 } });
            return { id: tour.id, revision: tour.revision + 1, replayed: false };
        }, options);
    }
    catch (e) {
        return normalizeMileageFailure(e);
    }
}
export async function readTours(truckId: string, deps: TourServiceDeps) { tourFlag(); const session = requireMileageSession(await deps.auth()); return deps.db.$transaction(async (tx) => { const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ"); const tours = await tx.vehicleTour.findMany({ where: { companyId: session.companyId, truckId }, include: { stops: { orderBy: { position: "asc" } }, mileageTrip: true }, orderBy: { startsAt: "desc" }, take: 100 }); const entries = await tx.mileageEntry.findMany({ where: { companyId: session.companyId, truckId }, orderBy: { revision: "asc" } }), history = resolveMileageHistory(entries); const canManage=["ADMIN","SUPER_ADMIN"].includes(session.role); const worksites = canManage ? await tx.worksite.findMany({ where: { companyId: session.companyId, archivedAt: null, address: { not: null } }, select: { id: true, name: true, address: true, clientId: true, latitude: true, longitude: true }, orderBy: { name: "asc" }, take: 200 }) : []; const clients = canManage ? await tx.client.findMany({ where: { companyId: session.companyId, active: true, address: { not: null } }, select: { id: true, name: true, address: true }, orderBy: { name: "asc" }, take: 200 }) : []; const settings = await tx.companySettings.findUnique({where:{companyId:session.companyId}}); return { timezone:settings?.timezone || "Europe/Paris", worksites, clients, truckId, matricule: truck.matricule, mileageRevision: truck.mileageRevision, currentMileage: truck.currentMileage, teamId: truck.teamId, chauffeurId: truck.chauffeurId, canManage, tours: tours.map(t => ({ ...t, actualKm: t.mileageTrip ? getMileageTripDistance(history, t.mileageTrip) : null, estimatedKmSource: t.estimatedKm === null ? null : "MANUAL" })) }; }, options); }
