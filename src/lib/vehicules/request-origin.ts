import { MileageDomainError } from "./mileage-domain"
import { assertMutationOrigin as assertMutationOriginShared } from "@/lib/http/request-origin"

/**
 * Shared mutation admission: actual Origin required; forwarding hints never grant authority.
 * Implémentation déplacée vers `src/lib/http/request-origin.ts` (SPEC-WORKSITE-PHOTOS-001 Lot 1) ;
 * cette façade conserve l'API et l'erreur `MileageDomainError(code, 403)` des routes Véhicules.
 */
export function assertMutationOrigin(request: Request, code = "INVALID_ORIGIN", env: NodeJS.ProcessEnv = process.env): void {
  assertMutationOriginShared(request, code, env, (rejectedCode, status) => { throw new MileageDomainError(rejectedCode, status) })
}
