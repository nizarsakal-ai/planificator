import { z } from "zod"

export const createEquipeSchema = z.object({
  name: z.string().min(1, "Le nom est requis").max(50),
  color: z.string().optional(),
  leaderId: z.string().min(1, "Le chef d'équipe est requis"),
  memberIds: z.array(z.string()).optional(),
})

export const updateEquipeSchema = z.object({
  name: z.string().min(1, "Le nom est requis").max(50),
  color: z.string().optional(),
  leaderId: z.string().min(1, "Le chef d'équipe est requis"),
})

export type CreateEquipeInput = z.infer<typeof createEquipeSchema>
export type UpdateEquipeInput = z.infer<typeof updateEquipeSchema>
