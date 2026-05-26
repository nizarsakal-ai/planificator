import { z } from "zod"

export const createAbsenceSchema = z.object({
  employeeId: z.string().min(1, "L'employé est requis"),
  type:       z.enum(["VACATION", "SICK", "UNPAID", "TRAINING", "OTHER"], {
    errorMap: () => ({ message: "Type d'absence invalide" }),
  }),
  startDate:  z.string().min(1, "La date de début est requise"),
  endDate:    z.string().min(1, "La date de fin est requise"),
  reason:     z.string().optional(),
}).refine((d) => new Date(d.endDate) >= new Date(d.startDate), {
  message: "La date de fin doit être après la date de début",
  path: ["endDate"],
})

export type CreateAbsenceInput = z.infer<typeof createAbsenceSchema>
