import { z } from "zod";
import { isVehiclesV3Enabled } from "./v3-feature-flag"
import { MileageDomainError } from "../mileage-domain";
const id = z.string().trim().min(1).max(200);
/** Durée maximale d'une tournée (déplacement de chantier longue distance : aller, séjour, retour). */
export const TOUR_MAX_DURATION_DAYS = 14;
export const TOUR_MAX_DURATION_MS = TOUR_MAX_DURATION_DAYS * 86400000;
export const tourStopSchema = z.object({ label: z.string().trim().min(1).max(200), address: z.string().trim().min(5).max(1000), worksiteId: id.nullable().optional(), clientId: id.nullable().optional(), latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(), addressValidated: z.literal(true) }).strict();
export const createTourSchema = z.object({ title: z.string().trim().min(1).max(200), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), teamId: id.nullable(), chauffeurId: id.nullable(), estimatedKm: z.number().finite().min(0).max(100000).nullable().optional(), estimatedKmAuto: z.boolean().optional(), approvedImportId: id.optional(), approvedImportRevision: z.number().int().positive().optional(), stops: z.array(tourStopSchema).max(50) }).strict().refine(x => (x.stops.length > 0 || !!x.approvedImportId) && (!!x.approvedImportId === !!x.approvedImportRevision) && (!x.approvedImportId || x.stops.length === 0)).refine(x => new Date(x.endsAt) > new Date(x.startsAt) && new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime() <= TOUR_MAX_DURATION_MS);
export type CreateTourInput = z.infer<typeof createTourSchema>;
export const editTourSchema = z.object({ type: z.literal("EDIT"), expectedRevision: z.number().int().nonnegative(), title: z.string().trim().min(1).max(200), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), estimatedKm: z.number().finite().min(0).max(100000).nullable(), estimatedKmAuto: z.boolean().optional(), stops: z.array(tourStopSchema).min(1).max(50), reason: z.string().trim().min(3).max(2000) }).strict();
export const tourCommandSchema = z.discriminatedUnion("type", [
    editTourSchema,
    z.object({type:z.literal("DETAILS"),expectedRevision:z.number().int().nonnegative(),title:z.string().trim().min(1).max(200),estimatedKm:z.number().finite().min(0).max(100000).nullable(),estimatedKmAuto:z.boolean().optional(),reason:z.string().trim().min(3).max(2000)}).strict(),
    z.object({ type: z.literal("START"), expectedRevision: z.number().int().nonnegative(), expectedMileageRevision: z.number().int().nonnegative(), mileage: z.number().int().min(0).max(9999999) }).strict(),
    z.object({ type: z.literal("COMPLETE"), expectedRevision: z.number().int().nonnegative(), expectedMileageRevision: z.number().int().nonnegative(), mileage: z.number().int().min(0).max(9999999) }).strict(),
    z.object({ type: z.literal("STOP"), expectedRevision: z.number().int().nonnegative(), stopId: id }).strict(),
    z.object({ type: z.literal("SKIP"), expectedRevision: z.number().int().nonnegative(), stopId: id, reason: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ type: z.literal("CANCEL"), expectedRevision: z.number().int().nonnegative() }).strict(),
]);
export type EstimatedKmSource = "AUTO" | "MANUAL"

/**
 * Source des km estimés après une saisie. `estimatedKmAuto: true` = calcul automatique (la valeur
 * envoyée est ignorée). Sans le champ (anciens clients) : aucune valeur = automatique ; une valeur
 * identique à l'estimation automatique en place (formulaire renvoyé tel quel) reste automatique ;
 * toute autre valeur devient manuelle et ne sera plus jamais écrasée.
 */
export function resolveEstimatedKm(
  input: { estimatedKm?: number | null; estimatedKmAuto?: boolean },
  current: { estimatedKm: number | null; estimatedKmSource: string | null } | null,
): { source: EstimatedKmSource; estimatedKm: number | null } {
  const keep = current?.estimatedKm ?? null
  if (input.estimatedKmAuto === true) return { source: "AUTO", estimatedKm: keep }
  const value = input.estimatedKm ?? null
  if (input.estimatedKmAuto === false && value !== null) return { source: "MANUAL", estimatedKm: value }
  if (value === null) return { source: "AUTO", estimatedKm: keep }
  if (current?.estimatedKmSource === "AUTO" && current.estimatedKm === value) return { source: "AUTO", estimatedKm: value }
  return { source: "MANUAL", estimatedKm: value }
}

export function tourFlag() { if (!isVehiclesV3Enabled())
    throw new MileageDomainError("V3_DISABLED", 404); }
export function tourParse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success)
    throw new MileageDomainError("INVALID_PAYLOAD", 400); return result.data; }
