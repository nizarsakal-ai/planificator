/** LOT-ADMIN-REVIEW — base factice en mémoire et stockage factice du contrôle Super Admin (données synthétiques). */
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import type { ReviewDb, ReviewPhotoRow, ReviewServiceDeps, ReviewTx } from "@/lib/worksite-photos/photo-review.service"
import type { ActorRow, PhotoSession } from "@/lib/worksite-photos/photo.service"

export const C1 = "company-1", C2 = "company-2"
export const sa: PhotoSession = { user: { id: "u-sa", role: "SUPER_ADMIN", companyId: C1 } }

export interface Store {
  actors: Map<string, ActorRow>
  companies: Map<string, { id: string; active: boolean }>
  photos: Map<string, ReviewPhotoRow>
  events: Array<Record<string, unknown>>
  clock: number
}

export function photo(id: string, over: Partial<ReviewPhotoRow> = {}): ReviewPhotoRow {
  return {
    id, companyId: C1, worksiteId: "w1", truckId: "t1", phase: "BEFORE", driveFileId: `drive-${id}`, uploadedAt: new Date("2026-10-31T08:00:00.000Z"),
    uploadedByNameSnapshot: "Ouvrier test", status: "PENDING", sentAt: null, approvedAt: null, approvedByNameSnapshot: null,
    rejectRequestedAt: null, rejectRequestedByNameSnapshot: null, rejectedAt: null, trashRequestedAt: null, trashRequestedByNameSnapshot: null, trashedAt: null,
    worksiteName: "Chantier test", clientName: "Client test", truckMatricule: "ZZ-000-ZZ", ...over,
  }
}

export function makeStore(): Store {
  return {
    actors: new Map<string, ActorRow>([
      ["u-sa", { id: "u-sa", name: "Super Admin test", email: "sa@example.test", role: "SUPER_ADMIN", companyId: C1, active: true }],
      ["u-admin", { id: "u-admin", name: "Admin test", email: "ad@example.test", role: "ADMIN", companyId: C1, active: true }],
      ["u-sa2", { id: "u-sa2", name: "Autre SA", email: "sa2@example.test", role: "SUPER_ADMIN", companyId: C2, active: true }],
    ]),
    companies: new Map([[C1, { id: C1, active: true }], [C2, { id: C2, active: true }]]),
    photos: new Map(),
    events: [],
    clock: Date.parse("2026-10-31T09:00:00.000Z"),
  }
}

export function fakeDb(store: Store, hooks: { beforeTx?: (n: number) => void } = {}): ReviewDb {
  let chain: Promise<unknown> = Promise.resolve()
  let txCount = 0
  const now = () => new Date(store.clock++)
  const reader = {
    findActor: async (id: string) => store.actors.get(id) ?? null,
    findCompany: async (id: string) => store.companies.get(id) ?? null,
    findEmployee: async () => null,
  }
  const get = (companyId: string, id: string) => { const p = store.photos.get(id); return p && p.companyId === companyId ? p : null }
  const conflict = () => { throw new WorksitePhotoDomainError("PHOTO_DELETION_CONFLICT", 409) }
  const tx: ReviewTx = {
    ...reader,
    lockPhoto: async (c, id) => { const p = get(c, id); return p ? { ...p } : null },
    approve: async (c, id, by) => {
      const p = get(c, id)
      if (!p || p.status !== "PENDING" || p.approvedAt || p.rejectRequestedAt) throw new WorksitePhotoDomainError("PHOTO_NOT_PENDING", 409)
      store.photos.set(id, { ...p, approvedAt: now(), approvedByNameSnapshot: by.name })
    },
    requestReject: async (c, id, by) => {
      const p = get(c, id)
      if (!p || p.status !== "PENDING" || p.rejectRequestedAt) conflict()
      store.photos.set(id, { ...p!, rejectRequestedAt: now(), rejectRequestedByNameSnapshot: by.name })
    },
    finalizeReject: async (c, id) => {
      const p = get(c, id)
      if (!p || p.status !== "PENDING" || !p.rejectRequestedAt) conflict()
      store.photos.set(id, { ...p!, status: "REJECTED", rejectedAt: now() })
    },
    requestTrash: async (c, id, by) => {
      const p = get(c, id)
      if (!p || p.status !== "SENT" || p.trashRequestedAt) conflict()
      store.photos.set(id, { ...p!, trashRequestedAt: now(), trashRequestedByNameSnapshot: by.name })
    },
    finalizeTrash: async (c, id) => {
      const p = get(c, id)
      if (!p || p.status !== "SENT" || !p.trashRequestedAt) conflict()
      store.photos.set(id, { ...p!, status: "DELETED", trashedAt: now() })
    },
    createEvent: async (data) => { store.events.push(data) },
  }
  return {
    ...reader,
    async findReviewPhotos(q) {
      return [...store.photos.values()]
        .filter((p) => p.companyId === q.companyId && (!q.worksiteId || p.worksiteId === q.worksiteId))
        .filter((p) => q.filter !== "TO_REVIEW" || (p.status === "PENDING" && !p.approvedAt && !p.rejectRequestedAt))
        .filter((p) => q.filter !== "REMOVED" || p.status === "REJECTED" || p.status === "DELETED")
        .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime() || (a.id < b.id ? 1 : -1))
        .filter((p) => !q.cursor || p.uploadedAt < q.cursor.uploadedAt || (p.uploadedAt.getTime() === q.cursor.uploadedAt.getTime() && p.id < q.cursor.id))
        .slice(0, q.take)
    },
    createEvent: async (data) => { store.events.push(data) },
    reviewTransaction<T>(fn: (t: ReviewTx) => Promise<T>): Promise<T> {
      const run = async () => {
        hooks.beforeTx?.(++txCount)
        const snapshot = new Map([...store.photos].map(([k, v]) => [k, { ...v }]))
        const eventCount = store.events.length
        try { return await fn(tx) } catch (error) {
          store.photos = snapshot
          store.events.length = eventCount
          throw error
        }
      }
      const result = chain.then(run, run)
      chain = result.catch(() => undefined)
      return result
    },
  }
}

export function storage(behaviour: "ok" | "missing" | "fail" = "ok") {
  const calls: string[] = []
  const deps: ReviewServiceDeps["storage"] = {
    trash: async (_c, id) => {
      calls.push(id)
      if (behaviour === "fail") throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true)
      return { missing: behaviour === "missing" }
    },
  }
  return { deps, calls }
}
