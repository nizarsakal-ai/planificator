import { z } from "zod"

export const createLogementSchema = z.object({
  teamId:       z.string().min(1, "L'équipe est requise"),
  startDate:    z.string().min(1, "La date d'arrivée est requise"),
  endDate:      z.string().min(1, "La date de départ est requise"),
  address:      z.string().min(1, "L'adresse est requise"),
  city:         z.string().optional(),
  zipCode:      z.string().optional(),
  doorCode:     z.string().optional(),
  contactName:  z.string().optional(),
  contactPhone: z.string().optional(),
  notes:        z.string().optional(),
}).refine(
  (d) => new Date(d.endDate) >= new Date(d.startDate),
  { message: "La date de départ doit être après la date d'arrivée", path: ["endDate"] }
)

export type CreateLogementInput = z.infer<typeof createLogementSchema>
