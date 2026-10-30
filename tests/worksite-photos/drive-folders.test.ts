/**
 * SPEC-WORKSITE-PHOTOS-001 Lot 2 — dossiers Drive par identité : identifiant préalloué, création idempotente (409),
 * réservation concurrente (ON CONFLICT ⇒ relecture), dossier supprimé à la main (404 ⇒ nouvel identifiant),
 * racine mémorisée sur la connexion.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { DriveApiClient, DriveFileMetadata } from "@/lib/worksite-photos/drive/drive-api.client"
import { DRIVE_FOLDER_MIME } from "@/lib/worksite-photos/drive/drive-api.client"
import { DriveProviderError } from "@/lib/worksite-photos/drive/drive.errors"
import { ensureFolder, normalizeDay, resolvePhotoFolders, type DriveFolderRecord, type DriveFoldersDb } from "@/lib/worksite-photos/drive/drive-folders"

function fakeDb(rows: DriveFolderRecord[] = []) {
  const state = { rows, connectionUpdates: [] as Record<string, unknown>[], conflictOnNextCreate: false, seq: 0 }
  const sameIdentity = (a: { worksiteId: string | null; day: Date | null }, b: { worksiteId: string | null; day: Date | null }) =>
    a.worksiteId === b.worksiteId && (a.day?.getTime() ?? null) === (b.day?.getTime() ?? null)
  const db: DriveFoldersDb = {
    worksitePhotoDriveFolder: {
      findFirst: async (args: { where: { companyId: string; worksiteId: string | null; day: Date | null } }) =>
        state.rows.find((r) => r.companyId === args.where.companyId && sameIdentity(r, args.where)) ?? null,
      createIfAbsent: async (data) => {
        if (state.conflictOnNextCreate) { state.conflictOnNextCreate = false; return null }
        if (state.rows.some((r) => r.companyId === data.companyId && sameIdentity(r, data))) return null
        const row: DriveFolderRecord = { id: `row-${++state.seq}`, state: "RESERVED", ...data }
        state.rows.push(row)
        return row
      },
      update: async (args: { where: { id: string }; data: Partial<DriveFolderRecord> }) => {
        const row = state.rows.find((r) => r.id === args.where.id)!
        Object.assign(row, args.data)
        return row
      },
      delete: async (args: { where: { id: string } }) => { state.rows = state.rows.filter((r) => r.id !== args.where.id); return null },
    },
    worksitePhotoDriveConnection: { update: async (args: { data: Record<string, unknown> }) => { state.connectionUpdates.push(args.data); return null } },
  }
  return { db, state }
}

function fakeDrive(options: { existingIds?: Set<string>; missingIds?: Set<string> } = {}) {
  const calls: string[] = []
  const existing = options.existingIds ?? new Set<string>()
  const missing = options.missingIds ?? new Set<string>()
  /** Objets distants : parent et type réels, modifiables pour simuler un objet incohérent sous notre identifiant. */
  const remote = new Map<string, { parent: string | null; mimeType: string; trashed: boolean }>()
  let counter = 0
  const meta = (id: string, name: string): DriveFileMetadata => {
    const r = remote.get(id) ?? { parent: null, mimeType: DRIVE_FOLDER_MIME, trashed: false }
    return { id, name, mimeType: r.mimeType, size: null, md5Checksum: null, trashed: r.trashed, parents: r.parent ? [r.parent] : [] }
  }
  const drive: DriveApiClient = {
    generateIds: async (_t, count) => { calls.push(`generateIds:${count}`); return Array.from({ length: count }, () => `gen-${++counter}`) },
    createFolder: async (_t, input) => {
      calls.push(`createFolder:${input.id}:${input.name}:${input.parentId ?? "root"}`)
      if (existing.has(input.id)) throw new DriveProviderError("DRIVE_ID_EXISTS", 409, false, 409, "fileIdAlreadyExists")
      existing.add(input.id)
      remote.set(input.id, { parent: input.parentId, mimeType: DRIVE_FOLDER_MIME, trashed: false })
      return meta(input.id, input.name)
    },
    createFile: async () => { throw new Error("not used") },
    downloadFile: async () => { throw new Error("not used") },
    getFile: async (_t, id) => {
      calls.push(`getFile:${id}`)
      if (missing.has(id)) throw new DriveProviderError("DRIVE_NOT_FOUND", 404, false, 404, "notFound")
      return meta(id, "x")
    },
    trashFile: async () => undefined,
    deleteFile: async () => undefined,
  }
  return { drive, calls, existing, missing, remote }
}

const day = new Date("2026-10-30T15:00:00.000Z")

describe("dossiers Drive par identité", () => {
  it("résout racine → chantier → jour avec identifiants préalloués, mémorise la racine sur la connexion", async () => {
    const { db, state } = fakeDb()
    const { drive, calls } = fakeDrive()
    const result = await resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", worksiteLabel: "Lauralu-Chantier A~w1", day, dayLabel: "2026-10-30" })
    assert.deepEqual(result, { rootId: "gen-1", worksiteFolderId: "gen-2", dayFolderId: "gen-3", worksiteLabel: "Lauralu-Chantier A~w1", dayLabel: "2026-10-30" })
    assert.deepEqual(calls, [
      "generateIds:1", "createFolder:gen-1:Chantiers:root",
      "generateIds:1", "createFolder:gen-2:Lauralu-Chantier A~w1:gen-1",
      "generateIds:1", "createFolder:gen-3:2026-10-30:gen-2",
    ])
    assert.deepEqual(state.connectionUpdates, [{ rootFolderId: "gen-1" }])
    assert.equal(state.rows.every((r) => r.state === "CREATED"), true)
    assert.equal(state.rows.find((r) => r.day)!.day!.getTime(), normalizeDay(day).getTime())
  })
  it("second appel : aucun nouvel identifiant, dossiers vérifiés et réutilisés, racine non réécrite", async () => {
    const { db, state } = fakeDb()
    const { drive, calls } = fakeDrive()
    await resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", worksiteLabel: "L-A~w1", day, dayLabel: "2026-10-30" })
    calls.length = 0
    const again = await resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: "gen-1" }, { worksiteId: "w1", worksiteLabel: "Renommé~w1", day, dayLabel: "2026-10-30" })
    assert.equal(again.dayFolderId, "gen-3")
    assert.equal(again.worksiteLabel, "L-A~w1", "libellé figé à la création : le renommage ne déplace rien")
    assert.deepEqual(calls, ["getFile:gen-3"], "chemin rapide : un seul contrôle Drive, sur le dossier le plus profond")
    assert.equal(state.connectionUpdates.length, 1)
  })
  it("chemin rapide invalidé : dossier du jour supprimé à la main ⇒ chaîne complète vérifiée, jour recréé, parents conservés", async () => {
    const { db, state } = fakeDb()
    const { drive, calls, missing } = fakeDrive()
    await resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", worksiteLabel: "L-A~w1", day, dayLabel: "2026-10-30" })
    missing.add("gen-3")
    calls.length = 0
    const again = await resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: "gen-1" }, { worksiteId: "w1", worksiteLabel: "L-A~w1", day, dayLabel: "2026-10-30" })
    assert.deepEqual([again.rootId, again.worksiteFolderId, again.dayFolderId], ["gen-1", "gen-2", "gen-4"])
    assert.deepEqual(calls, ["getFile:gen-3", "getFile:gen-1", "getFile:gen-2", "getFile:gen-3", "generateIds:1", "createFolder:gen-4:2026-10-30:gen-2"])
    assert.equal(state.rows.filter((r) => r.day).length, 1)
  })
  it("réservation concurrente (ON CONFLICT ⇒ null) : relecture de la ligne gagnante ; 409 Drive traité comme existant", async () => {
    const { db, state } = fakeDb([{ id: "row-x", companyId: "c1", worksiteId: null, day: null, driveFolderId: "other-root", path: "Chantiers", state: "RESERVED" }])
    const { drive, existing, calls } = fakeDrive()
    existing.add("other-root") // créé par l'autre requête entre-temps
    state.conflictOnNextCreate = true
    const root = await ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: null, day: null }, "Chantiers", null)
    assert.equal(root.driveFolderId, "other-root")
    assert.equal(root.state, "CREATED")
    assert.ok(calls.includes("createFolder:other-root:Chantiers:root"))
    assert.equal(state.rows.length, 1)
  })
  it("L2-R5 : collision reconnue mais objet distant incohérent (corbeille, autre type, autre parent) ⇒ DRIVE_CONFLICT, ligne laissée RESERVED", async () => {
    for (const mismatch of [{ trashed: true }, { mimeType: "image/jpeg" }, { parent: "ailleurs" }]) {
      const { db, state } = fakeDb([{ id: "row-w", companyId: "c1", worksiteId: "w1", day: null, driveFolderId: "w-folder", path: "Lauralu-A~w1", state: "RESERVED" }])
      const { drive, existing, remote } = fakeDrive()
      existing.add("w-folder")
      remote.set("w-folder", { parent: "root-folder", mimeType: DRIVE_FOLDER_MIME, trashed: false, ...mismatch })
      await assert.rejects(
        ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", day: null }, "Lauralu-A~w1", "root-folder"),
        (e: unknown) => e instanceof DriveProviderError && e.code === "DRIVE_CONFLICT" && e.reason === "existing_object_mismatch",
        JSON.stringify(mismatch),
      )
      assert.equal(state.rows[0].state, "RESERVED", "aucun faux CREATED")
    }
  })
  it("L2-R5 : collision reconnue et objet distant conforme (dossier, bon parent, hors corbeille) ⇒ CREATED", async () => {
    const { db, state } = fakeDb([{ id: "row-w", companyId: "c1", worksiteId: "w1", day: null, driveFolderId: "w-folder", path: "Lauralu-A~w1", state: "RESERVED" }])
    const { drive, existing, remote, calls } = fakeDrive()
    existing.add("w-folder")
    remote.set("w-folder", { parent: "root-folder", mimeType: DRIVE_FOLDER_MIME, trashed: false })
    const folder = await ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", day: null }, "Lauralu-A~w1", "root-folder")
    assert.equal(folder.state, "CREATED")
    assert.equal(state.rows[0].state, "CREATED")
    assert.ok(calls.includes("getFile:w-folder"), "objet distant contrôlé")
  })
  it("L2-R5 : 409 non reconnu (DRIVE_CONFLICT) remonte tel quel, aucune ligne marquée CREATED", async () => {
    const { db, state } = fakeDb([{ id: "row-w", companyId: "c1", worksiteId: "w1", day: null, driveFolderId: "w-folder", path: "Lauralu-A~w1", state: "RESERVED" }])
    const { drive } = fakeDrive()
    drive.createFolder = async () => { throw new DriveProviderError("DRIVE_CONFLICT", 409, false, 409, "unrelatedConflict") }
    await assert.rejects(ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", day: null }, "Lauralu-A~w1", "root-folder"),
      (e: unknown) => e instanceof DriveProviderError && e.code === "DRIVE_CONFLICT")
    assert.equal(state.rows[0].state, "RESERVED")
  })
  it("dossier CREATED supprimé à la main (404) : ligne remplacée, nouvel identifiant, nouvelle création", async () => {
    const { db, state } = fakeDb([{ id: "row-r", companyId: "c1", worksiteId: null, day: null, driveFolderId: "old-root", path: "Chantiers", state: "CREATED" }])
    const { drive, missing, calls } = fakeDrive()
    missing.add("old-root")
    const root = await ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: "old-root" }, { worksiteId: null, day: null }, "Chantiers", null)
    assert.equal(root.driveFolderId, "gen-1")
    assert.deepEqual(calls, ["getFile:old-root", "generateIds:1", "createFolder:gen-1:Chantiers:root"])
    assert.equal(state.rows.length, 1)
    assert.equal(state.rows[0].driveFolderId, "gen-1")
  })
  it("identité DATE incohérente avec le libellé du jour ⇒ refus avant tout appel (contrat jour civil, L3-R3)", async () => {
    const { db, state } = fakeDb()
    const { drive, calls } = fakeDrive()
    await assert.rejects(
      resolvePhotoFolders({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: null }, { worksiteId: "w1", worksiteLabel: "L", day: new Date("2026-10-30T23:30:00.000Z"), dayLabel: "2026-10-31" }),
      /identité de dossier 2026-10-30 incohérente avec le libellé 2026-10-31/,
    )
    assert.deepEqual(calls, [])
    assert.equal(state.rows.length, 0)
  })
  it("erreur Drive autre que 404/409 remonte telle quelle (aucune suppression de ligne)", async () => {
    const { db, state } = fakeDb([{ id: "row-r", companyId: "c1", worksiteId: null, day: null, driveFolderId: "root", path: "Chantiers", state: "CREATED" }])
    const { drive } = fakeDrive()
    drive.getFile = async () => { throw new DriveProviderError("DRIVE_UNAVAILABLE", 502, true, 503, null) }
    await assert.rejects(ensureFolder({ db, drive, accessToken: "tok", companyId: "c1", rootFolderId: "root" }, { worksiteId: null, day: null }, "Chantiers", null), (e: unknown) => e instanceof DriveProviderError && e.code === "DRIVE_UNAVAILABLE")
    assert.equal(state.rows.length, 1)
  })
})
