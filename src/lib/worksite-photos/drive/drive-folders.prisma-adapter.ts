/**
 * Adaptateur Prisma du port `DriveFoldersDb` : `createIfAbsent` s'appuie sur l'index unique d'identité
 * `(companyId, worksiteId, day) NULLS NOT DISTINCT` posé par la migration du Lot 1 : une violation d'unicité
 * (P2002) signifie qu'une autre requête a déjà réservé le dossier ⇒ `null`, l'appelant relit la ligne.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import type { DriveFolderRecord, DriveFoldersDb } from "./drive-folders"

type Db = Pick<PrismaClient, "worksitePhotoDriveFolder" | "worksitePhotoDriveConnection">

export function prismaDriveFoldersDb(prisma: Db): DriveFoldersDb {
  return {
    worksitePhotoDriveFolder: {
      findFirst: (args) => prisma.worksitePhotoDriveFolder.findFirst(args) as Promise<DriveFolderRecord | null>,
      createIfAbsent: async (data) => {
        try {
          return (await prisma.worksitePhotoDriveFolder.create({ data })) as DriveFolderRecord
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return null
          throw error
        }
      },
      update: (args) => prisma.worksitePhotoDriveFolder.update(args),
      delete: (args) => prisma.worksitePhotoDriveFolder.delete(args),
    },
    worksitePhotoDriveConnection: {
      update: (args) => prisma.worksitePhotoDriveConnection.update(args),
    },
  }
}
