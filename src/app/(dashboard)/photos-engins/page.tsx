import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isWorksitePhotosEnabled } from "@/lib/worksite-photos/feature-flag"
import { WorksitePhotoDomainError } from "@/lib/worksite-photos/photo.domain"
import { listPhotos, listUploadContext } from "@/lib/worksite-photos/photo.service"
import { listReviewPhotos } from "@/lib/worksite-photos/photo-review.service"
import { productionPhotoDeps } from "@/lib/worksite-photos/photo.deps"
import { PhotosEnginsView } from "@/components/worksite-photos/PhotosEnginsView"
import { PhotosReviewGallery } from "@/components/worksite-photos/PhotosReviewGallery"

export const metadata: Metadata = { title: "Photos engins" }

/**
 * Page ouvrier (SPEC-WORKSITE-PHOTOS-001 §6.1) : tant que le drapeau est absent, la page n'existe pas (404).
 * Les chantiers proposés suivent les filtres d'affectation du rôle (D8) ; le serveur relit les droits à chaque envoi.
 * SUPER_ADMIN : galerie de contrôle en plus (LOT-ADMIN-REVIEW) ; l'autorité est relue en base par le service, pas par la page.
 */
export default async function PhotosEnginsPage() {
  if (!isWorksitePhotosEnabled()) notFound()
  const session = await auth()
  if (!session?.user) redirect("/login")
  const deps = productionPhotoDeps()
  try {
    const context = await listUploadContext(session, deps)
    const header = (
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Photos engins</h1>
        <p className="text-sm text-slate-500 mt-1">Avant / Après chantier — enregistrées dans le dossier du chantier sur le Drive de l&apos;entreprise. Aucun envoi automatique au client n&apos;est actif.</p>
      </div>
    )
    if (context.role === "SUPER_ADMIN" && deps.reviewDb) {
      // SUPER_ADMIN : la galerie de contrôle d'abord ; l'ajout reste possible dans une section repliable secondaire.
      const review = await listReviewPhotos(session, { worksiteId: null, filter: "ALL", cursor: null, limit: null }, { reviewDb: deps.reviewDb, storage: deps.storage })
      return (
        <div className="space-y-6">
          {header}
          <PhotosReviewGallery worksites={context.worksites} initialPage={review} />
          <details className="group rounded-lg border border-slate-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700">Ajouter une photo</summary>
            <div className="px-4 pb-4"><PhotosEnginsView context={context} initialPhotos={[]} showList={false} /></div>
          </details>
        </div>
      )
    }
    const first = context.worksites[0]?.id ?? null
    const { photos } = first ? await listPhotos(session, { worksiteId: first, cursor: null, limit: "50" }, deps) : { photos: [] }
    return (
      <div className="space-y-6">
        {header}
        <PhotosEnginsView context={context} initialPhotos={photos} />
      </div>
    )
  } catch (error) {
    if (error instanceof WorksitePhotoDomainError && [401, 403, 404].includes(error.status)) redirect("/dashboard")
    throw error
  }
}
