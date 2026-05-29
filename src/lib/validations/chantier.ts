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

export const updateChantierSchema = z.object({
  name:        z.string().min(1, "Le nom est requis").max(100),
  description: z.string().optional(),
  address:     z.string().optional(),
  clientId:    z.string().min(1, "Le client est requis"),
  startDate:   z.string().min(1, "La date de début est requise"),
  endDate:     z.string().min(1, "La date de fin est requise"),
  dailyHours:  z.coerce.number().min(1).max(24),
}).refine((data) => new Date(data.endDate) >= new Date(data.startDate), {
  message: "La date de fin doit être après la date de début",
  path: ["endDate"],
})

export type UpdateChantierInput = z.infer<typeof updateChantierSchema>

export const extendChantierSchema = z.object({
  newEndDate: z.string().min(1, "La nouvelle date de fin est requise"),
  reason: z.string().optional(),
})

export type CreateChantierInput = z.infer<typeof createChantierSchema>
export type ExtendChantierInput = z.infer<typeof extendChantierSchema>
