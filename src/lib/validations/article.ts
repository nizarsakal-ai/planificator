import { z } from "zod"

export const articleSchema = z.object({
  reference:   z.string().max(50).optional(),
  designation: z.string().min(1, "La désignation est requise").max(200),
  description: z.string().max(1000).optional(),
  unit:        z.string().min(1, "L'unité est requise").max(20),
  unitPrice:   z.coerce.number().min(0, "Le prix doit être positif"),
  vatRate:     z.coerce.number().min(0, "TVA invalide").max(100, "TVA invalide"),
})

export type ArticleInput = z.infer<typeof articleSchema>
