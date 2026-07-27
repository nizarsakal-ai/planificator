import { z } from "zod"

/**
 * Règle unique pour les strings optionnelles du formulaire Absence :
 * - string non vide → conserver (trim)
 * - null / "" / undefined → undefined
 * - jamais `null` dans le payload validé
 */
export function emptyToUndefined(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string" && value.trim() === "") return undefined
  return value
}

/**
 * Champ FormData → string | undefined (jamais null).
 * Accepte uniquement string ; File / Blob / autre → undefined
 * (les champs obligatoires sont ensuite rejetés par Zod).
 */
export function formDataString(
  formData: FormData,
  key: string
): string | undefined {
  const value = formData.get(key)
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") return undefined
  return value.trim() === "" ? undefined : value
}

const optionalReasonSchema = z.preprocess(
  emptyToUndefined,
  z.string().min(1).optional()
)

export const createAbsenceSchema = z
  .object({
    employeeId: z.string().min(1, "L'employé est requis"),
    type: z.enum(["VACATION", "SICK", "UNPAID", "TRAINING", "OTHER"], {
      errorMap: () => ({ message: "Type d'absence invalide" }),
    }),
    startDate: z.string().min(1, "La date de début est requise"),
    endDate: z.string().min(1, "La date de fin est requise"),
    reason: optionalReasonSchema,
  })
  .refine((d) => new Date(d.endDate) >= new Date(d.startDate), {
    message: "La date de fin doit être après la date de début",
    path: ["endDate"],
  })

export type CreateAbsenceInput = z.infer<typeof createAbsenceSchema>

/** Valeurs brutes avant validation Zod (strings déjà normalisées ou absentes). */
export type CreateAbsenceRawInput = {
  employeeId?: string
  type?: string
  startDate?: string
  endDate?: string
  reason?: string
}

/**
 * Point d’entrée unique de validation Absences create / demander.
 * Aucune action ne doit appeler `createAbsenceSchema.safeParse` en parallèle.
 */
export function parseCreateAbsenceInput(input: CreateAbsenceRawInput) {
  return createAbsenceSchema.safeParse({
    employeeId: emptyToUndefined(input.employeeId),
    type: emptyToUndefined(input.type),
    startDate: emptyToUndefined(input.startDate),
    endDate: emptyToUndefined(input.endDate),
    reason: emptyToUndefined(input.reason),
  })
}

/** Adaptateur FormData → contrat partagé. */
export function parseCreateAbsenceFormData(formData: FormData) {
  return parseCreateAbsenceInput({
    employeeId: formDataString(formData, "employeeId"),
    type: formDataString(formData, "type"),
    startDate: formDataString(formData, "startDate"),
    endDate: formDataString(formData, "endDate"),
    reason: formDataString(formData, "reason"),
  })
}

/**
 * Sérialise un CreateAbsenceInput vers FormData sans jamais écrire null.
 * Les champs optionnels absents / vides sont omis (→ undefined côté serveur).
 */
export function appendCreateAbsenceFormData(
  formData: FormData,
  data: CreateAbsenceInput
): void {
  formData.set("employeeId", data.employeeId)
  formData.set("type", data.type)
  formData.set("startDate", data.startDate)
  formData.set("endDate", data.endDate)
  if (data.reason !== undefined && data.reason.trim() !== "") {
    formData.set("reason", data.reason.trim())
  }
}

/** Données prêtes pour `prisma.absence.create` (reason DB nullable). */
export type AbsencePersistenceData = {
  employeeId: string
  type: CreateAbsenceInput["type"]
  startDate: Date
  endDate: Date
  reason: string | null
}

/**
 * Mapper local Absences : contrat validé → persistance Prisma.
 * reason string → string ; reason undefined → null.
 */
export function toAbsencePersistenceData(
  input: CreateAbsenceInput
): AbsencePersistenceData {
  return {
    employeeId: input.employeeId,
    type: input.type,
    startDate: new Date(input.startDate),
    endDate: new Date(input.endDate),
    reason: input.reason === undefined ? null : input.reason,
  }
}
