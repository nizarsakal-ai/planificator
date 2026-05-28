import { z } from "zod"

export const createEmployeSchema = z.object({
  firstName: z.string().min(1, "Le prénom est requis").max(50),
  lastName: z.string().min(1, "Le nom est requis").max(50),
  email: z.string().min(1, "L'email est requis").email("Email invalide"),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  password: z
    .string()
    .min(8, "Minimum 8 caractères")
    .regex(/[A-Z]/, "Au moins une majuscule")
    .regex(/[0-9]/, "Au moins un chiffre"),
})

export const updateEmployeSchema = z.object({
  firstName: z.string().min(1, "Le prénom est requis").max(50),
  lastName: z.string().min(1, "Le nom est requis").max(50),
  jobTitle: z.string().optional(),
  phone: z.string().optional(),
  hiredAt: z.string().optional(),
})

export type CreateEmployeInput = z.infer<typeof createEmployeSchema>
export type UpdateEmployeInput = z.infer<typeof updateEmployeSchema>
