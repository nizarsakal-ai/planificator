import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isWorksitePhotosEnabled } from "@/lib/worksite-photos/feature-flag"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import { listPhotos, listUploadContext } from "@/lib/worksite-photos/photo.service"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"
import { PhotosEnginsView } from "@/components/worksite-photos/PhotosEnginsView"

export const metadata: Metadata = { title: "Photos engins" }

/**
 * Page ouvrier (SPEC-WORKSITE-PHOTOS-001 §6.1) : tant que le drapeau est absent, la page n'existe pas (404).
 * Les chantiers proposés suivent les filtres d'affectation du rôle (D8) ; le serveur relit les droits à chaque envoi.
 */
export default async function PhotosEnginsPage() {
  if (!isWorksitePhotosEnabled()) notFound()
  const session = await auth()
  if (!session?.user) redirect("/login")
  const deps = productionPhotoDeps()
  try {
    const context = await listUploadContext(session, deps)
    const first = context.worksites[0]?.id ?? null
    const { photos } = first ? await listPhotos(session, { worksiteId: first, cursor: null, limit: "50" }, deps) : { photos: [] }
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Photos engins</h1>
          <p className="text-sm text-slate-500 mt-1">Avant / Après chantier — enregistrées dans le dossier du chantier, transmises au client par Hermes</p>
        </div>
        <PhotosEnginsView context={context} initialPhotos={photos} />
      </div>
    )
  } catch (error) {
    if (error instanceof WorksitePhotoDomainError && [401, 403, 404].includes(error.status)) redirect("/dashboard")
    throw error
  }
}
