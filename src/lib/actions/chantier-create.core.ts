/**
 * LOT-1W-1a — Cœur de `createChantier` (hors "use server"), extrait à parité stricte de
 * `chantier.actions.ts` l.25–78 à BASE_SHA a84c73f. Aucune requête, aucun contrôle, aucun message
 * ajouté ou modifié ; les durcissements relèvent de 1W-1b.
 *
 * Reste dans l'adaptateur : `requireAdmin`, la lecture du `FormData`, `revalidatePath`.
 */

import type { Prisma } from "@prisma/client"
import { createChantierSchema } from "@/lib/validations/chantier"
import type { CoreResult, WriteActor } from "@/lib/actions/write-actor"

/** Valeurs brutes du formulaire (`FormData.get`, typées `string` par l'adaptateur) ; validées par Zod ici. */
export type CreateWorksiteInput = Readonly<{
  name: string
  description: string
  address: string
  clientId: string
  startDate: string
  endDate: string
  dailyHours: string
}>

export type CreateWorksiteDeps = {
  /** `prisma.client.findFirst(args)` — mêmes arguments qu'à BASE_SHA. */
  findClient: (args: { where: { id: string; companyId: string } }) => Promise<object | null>
  /** `prisma.worksite.create(args)` — mêmes champs et valeurs qu'à BASE_SHA. */
  createWorksite: (args: { data: Prisma.WorksiteUncheckedCreateInput }) => Promise<{ id: string }>
  /** `defaultGeocodePort.geocodeAddress` — appelé uniquement si `address` est renseignée. */
  geocode: (address: string) => Promise<{ latitude: number; longitude: number } | null>
}

export async function createWorksiteCore(
  input: CreateWorksiteInput,
  actor: WriteActor,
  deps: CreateWorksiteDeps
): Promise<CoreResult<{ worksiteId: string }>> {
  const parsed = createChantierSchema.safeParse(input)
  if (!parsed.success) return { ok: false, code: "VALIDATION", details: { message: parsed.error.errors[0].message } }

  // Vérifier que le client appartient à cette entreprise
  const client = await deps.findClient({
    where: { id: parsed.data.clientId, companyId: actor.companyId },
  })
  if (!client) return { ok: false, code: "CLIENT_NOT_FOUND", details: { message: "Client introuvable." } }

  // Géocodage de l'adresse via Nominatim (OpenStreetMap)
  let latitude: number | null = null
  let longitude: number | null = null
  if (parsed.data.address) {
    const geo = await deps.geocode(parsed.data.address)
    if (geo) {
      latitude = geo.latitude
      longitude = geo.longitude
    }
  }

  const created = await deps.createWorksite({
    data: {
      name:        parsed.data.name,
      description: parsed.data.description || null,
      address:     parsed.data.address || null,
      clientId:    parsed.data.clientId,
      companyId:   actor.companyId,
      createdById: actor.actorUserId,
      startDate:   new Date(parsed.data.startDate),
      endDate:     new Date(parsed.data.endDate),
      dailyHours:  parsed.data.dailyHours,
      status:      "PLANNED",
      latitude,
      longitude,
    },
  })

  return { ok: true, data: { worksiteId: created.id } }
}
