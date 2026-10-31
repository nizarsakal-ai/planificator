/**
 * Adaptateur Prisma du port `PhotoDb` (photo.service.ts). Toutes les requêtes portent `companyId`.
 * Visibilité des chantiers (D8) : EMPLOYEE ⇒ affecté via employeeAssignments ; TEAM_LEADER ⇒ équipe(s) dirigée(s) affectée(s) ;
 * administrateurs ⇒ toute l'entreprise. `createReservationIfAbsent` s'appuie sur l'unicité `(companyId, idempotencyKey)` (P2002 ⇒ null).
 * Les CAS sont des `updateMany` conditionnels (état + génération, et `driveFileCreatedAt IS NULL` si demandé) ; la transaction
 * verrouille en `FOR SHARE` le chantier, l'engin, puis — pour la relecture de l'autorité — le compte, l'entreprise, la fiche employé
 * et les lignes d'affectation qui ouvrent la visibilité : une désactivation ou un retrait concurrent attend la fin de la publication.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import type { ActorReader, ActorRow, EmployeeRow, PhotoDb, PhotoRow, PhotoTx, ReservationRow, TruckRow, WorksiteQuery, WorksiteRow } from "./photo.service"
import type { ReviewDb, ReviewPhotoRow, ReviewQuery, ReviewTx } from "./photo-review.service"
import { WorksitePhotoDomainError } from "./photo.domain"

type Db = Pick<PrismaClient, "user" | "company" | "employee" | "companySettings" | "worksite" | "truck" | "worksitePhotoUploadReservation" | "worksiteTruckPhoto" | "worksitePhotoEvent" | "$transaction">
type Tx = Prisma.TransactionClient

const TX_OPTIONS = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }

function worksiteWhere(query: WorksiteQuery): Prisma.WorksiteWhereInput {
  const where: Prisma.WorksiteWhereInput = { companyId: query.companyId }
  if (query.worksiteId) where.id = query.worksiteId
  if (query.excludeArchived) where.status = { not: "ARCHIVED" }
  if (query.visibility.kind === "employee") where.assignments = { some: { employeeAssignments: { some: { employeeId: query.visibility.employeeId } } } }
  if (query.visibility.kind === "teams") where.assignments = { some: { teamId: { in: query.visibility.teamIds } } }
  return where
}

const worksiteSelect = { id: true, name: true, status: true, companyId: true, client: { select: { name: true } } } as const
const toWorksite = (w: { id: string; name: string; status: string; companyId: string; client: { name: string } }): WorksiteRow =>
  ({ id: w.id, name: w.name, status: w.status, companyId: w.companyId, clientName: w.client.name })

const reservationSelect = {
  id: true, companyId: true, idempotencyKey: true, requestHash: true, worksiteId: true, truckId: true, uploadedById: true, photoId: true, driveFileId: true,
  state: true, attemptGeneration: true, attemptOwner: true, leaseExpiresAt: true, driveFileCreatedAt: true, abandonedAt: true,
} as const

const photoSelect = {
  id: true, companyId: true, worksiteId: true, truckId: true, phase: true, status: true, driveFileId: true, drivePath: true, originalFilename: true, mimeType: true,
  sizeBytes: true, sha256: true, takenAt: true, uploadedAt: true, uploadedById: true, uploadedByNameSnapshot: true, sentAt: true, trashedAt: true,
} as const

/** Lectures d'autorité, partagées entre le client et la transaction (`lock` = verrous `FOR SHARE` posés avant chaque lecture). */
function actorReader(client: Tx | Db, lock: boolean): ActorReader {
  return {
    async findActor(userId) {
      if (lock) await (client as Tx).$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR SHARE`
      return client.user.findFirst({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, companyId: true, active: true } }) as Promise<ActorRow | null>
    },
    async findCompany(companyId) {
      if (lock) await (client as Tx).$queryRaw`SELECT "id" FROM "companies" WHERE "id" = ${companyId} FOR SHARE`
      return client.company.findFirst({ where: { id: companyId }, select: { id: true, active: true } })
    },
    async findEmployee(userId, companyId) {
      if (lock) {
        // Fiche, puis les équipes qu'elle dirige dans l'entreprise (actives ou non) : leur désactivation ou un changement de chef
        // (`UPDATE teams`) attend la fin de la publication. Ordre fixe : employees → teams → assignments (L3R2-R1).
        const locked = await (client as Tx).$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "employees" WHERE "userId" = ${userId} AND "companyId" = ${companyId} FOR SHARE`
        if (locked.length > 0) {
          await (client as Tx).$queryRaw`SELECT "id" FROM "teams" WHERE "leaderId" = ${locked[0].id} AND "companyId" = ${companyId} ORDER BY "id" FOR SHARE`
        }
      }
      // Relue APRÈS les verrous : seules les équipes encore actives, encore dirigées par cette fiche, dans l'entreprise, ouvrent la visibilité.
      const employee = await client.employee.findFirst({
        where: { userId, companyId },
        select: { id: true, firstName: true, lastName: true, active: true, role: true, ledTeams: { where: { active: true, companyId }, select: { id: true } } },
      })
      if (!employee) return null
      const row: EmployeeRow = { id: employee.id, firstName: employee.firstName, lastName: employee.lastName, active: employee.active, role: employee.role, ledTeamIds: employee.ledTeams.map((t) => t.id) }
      return row
    },
  }
}

/** Verrouille les affectations qui ouvrent la visibilité d'UN chantier à l'acteur (relecture transactionnelle, L3-R1). */
async function lockVisibilityRows(tx: Tx, query: WorksiteQuery): Promise<void> {
  if (!query.worksiteId) return
  if (query.visibility.kind === "employee") {
    await tx.$queryRaw`SELECT ea."id" FROM "employee_assignments" ea JOIN "assignments" a ON a."id" = ea."assignmentId"
      WHERE a."worksiteId" = ${query.worksiteId} AND ea."employeeId" = ${query.visibility.employeeId} FOR SHARE`
  } else if (query.visibility.kind === "teams" && query.visibility.teamIds.length > 0) {
    await tx.$queryRaw`SELECT a."id" FROM "assignments" a WHERE a."worksiteId" = ${query.worksiteId} AND a."teamId" IN (${Prisma.join(query.visibility.teamIds)}) FOR SHARE`
  }
}

async function findWorksitesWith(client: Tx | Db, query: WorksiteQuery): Promise<WorksiteRow[]> {
  const rows = await client.worksite.findMany({ where: worksiteWhere(query), select: worksiteSelect, orderBy: [{ status: "asc" }, { name: "asc" }], take: query.take ?? 200 })
  return rows.map(toWorksite)
}

function txPort(tx: Tx): PhotoTx {
  return {
    ...actorReader(tx, true),
    async findWorksites(query) {
      await lockVisibilityRows(tx, query)
      return findWorksitesWith(tx, query)
    },
    async lockWorksiteAndTruck(companyId, worksiteId, truckId) {
      await tx.$queryRaw`SELECT "id" FROM "worksites" WHERE "id" = ${worksiteId} AND "companyId" = ${companyId} FOR SHARE`
      await tx.$queryRaw`SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${companyId} FOR SHARE`
      const [worksite, truck] = await Promise.all([
        tx.worksite.findFirst({ where: { id: worksiteId, companyId }, select: worksiteSelect }),
        tx.truck.findFirst({ where: { id: truckId, companyId }, select: { id: true, matricule: true, active: true, companyId: true } }),
      ])
      return { worksite: worksite ? toWorksite(worksite) : null, truck }
    },
    async reservationCas(where, data) {
      const result = await tx.worksitePhotoUploadReservation.updateMany({ where, data: data as Prisma.WorksitePhotoUploadReservationUpdateManyMutationInput })
      return result.count
    },
    createPhoto: (data) => tx.worksiteTruckPhoto.create({ data: data as Prisma.WorksiteTruckPhotoUncheckedCreateInput, select: photoSelect }) as Promise<PhotoRow>,
    createEvent: (data) => tx.worksitePhotoEvent.create({ data: data as Prisma.WorksitePhotoEventUncheckedCreateInput }),
  }
}

export function prismaPhotoDb(prisma: Db): PhotoDb {
  return {
    ...actorReader(prisma, false),
    async findTimezone(companyId) {
      const settings = await prisma.companySettings.findFirst({ where: { companyId }, select: { timezone: true } })
      return settings?.timezone ?? null
    },
    findWorksites: (query) => findWorksitesWith(prisma, query),
    findTrucks: (companyId, truckId) => prisma.truck.findMany({ where: { companyId, ...(truckId ? { id: truckId } : {}) }, select: { id: true, matricule: true, active: true, companyId: true }, orderBy: { matricule: "asc" } }) as Promise<TruckRow[]>,
    async createReservationIfAbsent(data) {
      try {
        return (await prisma.worksitePhotoUploadReservation.create({ data: data as Prisma.WorksitePhotoUploadReservationUncheckedCreateInput, select: reservationSelect })) as ReservationRow
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null
        throw error
      }
    },
    findReservationByKey: (companyId, idempotencyKey) => prisma.worksitePhotoUploadReservation.findFirst({ where: { companyId, idempotencyKey }, select: reservationSelect }) as Promise<ReservationRow | null>,
    async reservationCas(where, data) {
      const result = await prisma.worksitePhotoUploadReservation.updateMany({ where, data: data as Prisma.WorksitePhotoUploadReservationUpdateManyMutationInput })
      return result.count
    },
    findPhotos: ({ companyId, worksiteIds, photoId, cursor, take }) => prisma.worksiteTruckPhoto.findMany({
      where: { companyId, ...(photoId ? { id: photoId } : {}), ...(worksiteIds ? { worksiteId: { in: worksiteIds } } : {}) },
      select: photoSelect, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }], take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }) as Promise<PhotoRow[]>,
    createEvent: (data) => prisma.worksitePhotoEvent.create({ data: data as Prisma.WorksitePhotoEventUncheckedCreateInput }),
    transaction: (fn) => prisma.$transaction((tx) => fn(txPort(tx)), TX_OPTIONS),
  }
}

// ─── Contrôle Super Admin (LOT-ADMIN-REVIEW) ─────────────────────────────────
// Toutes les écritures portent `companyId` ; la garde SQL des photos impose les transitions, les horodatages (clock_timestamp)
// et le figement. Les écritures de la suppression APRÈS envoi utilisent `clock_timestamp()` côté base ; celles de la validation
// et du rejet passent une valeur que la garde remplace par l'heure de la base.

const reviewSelect = {
  id: true, companyId: true, worksiteId: true, truckId: true, phase: true, status: true, driveFileId: true, uploadedAt: true, uploadedByNameSnapshot: true,
  sentAt: true, approvedAt: true, approvedByNameSnapshot: true, rejectRequestedAt: true, rejectRequestedByNameSnapshot: true, rejectedAt: true,
  trashRequestedAt: true, trashRequestedByNameSnapshot: true, trashedAt: true,
  worksite: { select: { name: true, client: { select: { name: true } } } }, truck: { select: { matricule: true } },
} as const

type ReviewSelected = Prisma.WorksiteTruckPhotoGetPayload<{ select: typeof reviewSelect }>

function toReviewRow(row: ReviewSelected): ReviewPhotoRow {
  const { worksite, truck, ...rest } = row
  return { ...rest, worksiteName: worksite.name, clientName: worksite.client.name, truckMatricule: truck.matricule }
}

function reviewWhere(query: ReviewQuery): Prisma.WorksiteTruckPhotoWhereInput {
  const and: Prisma.WorksiteTruckPhotoWhereInput[] = [{ companyId: query.companyId }]
  if (query.worksiteId) and.push({ worksiteId: query.worksiteId })
  switch (query.filter) {
    case "TO_REVIEW": and.push({ status: "PENDING", approvedAt: null, rejectRequestedAt: null }); break
    case "APPROVED": and.push({ status: "PENDING", approvedAt: { not: null }, rejectRequestedAt: null }); break
    case "SENT": and.push({ status: "SENT", trashRequestedAt: null }); break
    case "TO_RESUME": and.push({ OR: [{ status: "PENDING", rejectRequestedAt: { not: null } }, { status: "SENT", trashRequestedAt: { not: null } }] }); break
    case "REMOVED": and.push({ status: { in: ["REJECTED", "DELETED"] } }); break
    case "ALL": break
  }
  if (query.cursor) and.push({ OR: [{ uploadedAt: { lt: query.cursor.uploadedAt } }, { uploadedAt: query.cursor.uploadedAt, id: { lt: query.cursor.id } }] })
  return { AND: and }
}

function reviewTxPort(tx: Tx): ReviewTx {
  const one = (count: number) => { if (count !== 1) throw new WorksitePhotoDomainError("PHOTO_DELETION_CONFLICT", 409) }
  return {
    ...actorReader(tx, true),
    async lockPhoto(companyId, photoId) {
      await tx.$queryRaw`SELECT "id" FROM "worksite_truck_photos" WHERE "id" = ${photoId} AND "companyId" = ${companyId} FOR UPDATE`
      const row = await tx.worksiteTruckPhoto.findFirst({ where: { id: photoId, companyId }, select: reviewSelect })
      return row ? toReviewRow(row) : null
    },
    async approve(companyId, photoId, by) {
      const { count } = await tx.worksiteTruckPhoto.updateMany({
        where: { id: photoId, companyId, status: "PENDING", approvedAt: null, rejectRequestedAt: null },
        data: { approvedAt: new Date(), approvedById: by.id, approvedByNameSnapshot: by.name },
      })
      if (count !== 1) throw new WorksitePhotoDomainError("PHOTO_NOT_PENDING", 409)
    },
    async requestReject(companyId, photoId, by) {
      one((await tx.worksiteTruckPhoto.updateMany({
        where: { id: photoId, companyId, status: "PENDING", rejectRequestedAt: null },
        data: { rejectRequestedAt: new Date(), rejectRequestedById: by.id, rejectRequestedByNameSnapshot: by.name },
      })).count)
    },
    async finalizeReject(companyId, photoId) {
      one((await tx.worksiteTruckPhoto.updateMany({
        where: { id: photoId, companyId, status: "PENDING", rejectRequestedAt: { not: null } },
        data: { status: "REJECTED", rejectedAt: new Date() },
      })).count)
    },
    async requestTrash(companyId, photoId, by) {
      one(await tx.$executeRaw`UPDATE "worksite_truck_photos" SET "trashRequestedAt" = clock_timestamp(), "trashRequestedById" = ${by.id}, "trashRequestedByNameSnapshot" = ${by.name}
        WHERE "id" = ${photoId} AND "companyId" = ${companyId} AND "status" = 'SENT' AND "trashRequestedAt" IS NULL`)
    },
    async finalizeTrash(companyId, photoId) {
      one(await tx.$executeRaw`UPDATE "worksite_truck_photos" SET "status" = 'DELETED', "trashedAt" = clock_timestamp()
        WHERE "id" = ${photoId} AND "companyId" = ${companyId} AND "status" = 'SENT' AND "trashRequestedAt" IS NOT NULL`)
    },
    createEvent: (data) => tx.worksitePhotoEvent.create({ data: data as Prisma.WorksitePhotoEventUncheckedCreateInput }),
  }
}

export function prismaReviewDb(prisma: Db): ReviewDb {
  return {
    ...actorReader(prisma, false),
    async findReviewPhotos(query) {
      const rows = await prisma.worksiteTruckPhoto.findMany({ where: reviewWhere(query), select: reviewSelect, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }], take: query.take })
      return rows.map(toReviewRow)
    },
    createEvent: (data) => prisma.worksitePhotoEvent.create({ data: data as Prisma.WorksitePhotoEventUncheckedCreateInput }),
    reviewTransaction: (fn) => prisma.$transaction((tx) => fn(reviewTxPort(tx)), TX_OPTIONS),
  }
}
