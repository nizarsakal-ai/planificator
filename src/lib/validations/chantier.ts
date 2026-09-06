import { z } from "zod"

export const createChantierSchema = z.object({
  name: z.string().min(1, "Le nom est requis").max(100),
  description: z.string().optional(),
  address: z.string().optional(),
  clientId: z.string().min(1, "Le client est requis"),
  startDate: z.string().min(1, "La date de début est requise"),
  endDate: z.string().min(1, "La date de fin est requise"),
  dailyHours: z.coerce.number().min(1).max(24).default(10),
}).refine((data) => new Date(data.endDate) >= new Date(data.startDate), {
  message: "La date de fin doit être après la date de début",
  path: ["endDate"],
})

/**
 * Formulaire HTML : "" / null / undefined → null (dates inconnues).
 * Jamais de fallback vers aujourd'hui / Invalid Date.
 */
const updateOptionalDateYmd = z.preprocess((v) => {
  if (v === null || v === undefined) return null
  if (typeof v !== "string") return v
  const t = v.trim()
  return t.length === 0 ? null : t
}, z.union([z.string().min(1), z.null()]))

export const updateChantierSchema = z
  .object({
    name: z.string().min(1, "Le nom est requis").max(100),
    description: z.string().optional(),
    address: z.string().optional(),
    clientId: z.string().min(1, "Le client est requis"),
    startDate: updateOptionalDateYmd,
    endDate: updateOptionalDateYmd,
    dailyHours: z.coerce.number().min(1).max(24),
  })
  .superRefine((data, ctx) => {
    const hasStart = data.startDate != null
    const hasEnd = data.endDate != null
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Les dates de début et de fin doivent être toutes deux renseignées ou toutes deux absentes",
        path: [hasStart ? "endDate" : "startDate"],
      })
      return
    }
    if (
      hasStart &&
      hasEnd &&
      new Date(data.endDate!) < new Date(data.startDate!)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "La date de fin doit être après la date de début",
        path: ["endDate"],
      })
    }
  })

export type UpdateChantierInput = z.infer<typeof updateChantierSchema>

/** Persistance update : YMD string → Date ; null → null. Aucun fallback. */
export function updateDateFieldToDb(value: string | null): Date | null {
  if (value == null) return null
  return new Date(value)
}

export const extendChantierSchema = z.object({
  newEndDate: z.string().min(1, "La nouvelle date de fin est requise"),
  reason: z.string().optional(),
})

export type CreateChantierInput = z.infer<typeof createChantierSchema>
export type ExtendChantierInput = z.infer<typeof extendChantierSchema>
