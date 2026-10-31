/**
 * Composition de production des dépendances des routes photos : Prisma + stockage Drive + session.
 * Un seul point d'assemblage ; les routes Next restent des wrappers fins.
 */
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import type { PhotoApiDeps } from "./photo.api"
import { prismaPhotoDb, prismaReviewDb } from "./photo.prisma-adapter"
import { createDrivePhotoStorage } from "./photo-storage.port"

let cached: PhotoApiDeps | null = null

export function productionPhotoDeps(): PhotoApiDeps {
  if (!cached) cached = { auth, db: prismaPhotoDb(prisma), reviewDb: prismaReviewDb(prisma), storage: createDrivePhotoStorage(prisma) }
  return cached
}
