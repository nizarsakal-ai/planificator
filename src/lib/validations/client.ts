import { z } from "zod"

export const createClientSchema = z.object({
  name: z.string().min(1, "Le nom est requis").max(100),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
  phone: z.string().optional(),
  address: z.string().optional(),
  // 21/11/2026 : adresse de livraison par défaut (factures, bons de livraison).
  deliveryAddress: z.string().max(500, "Adresse de livraison : 500 caractères maximum.").optional(),
  notes: z.string().optional(),
})

export const updateClientSchema = createClientSchema

export type CreateClientInput = z.infer<typeof createClientSchema>
export type UpdateClientInput = z.infer<typeof updateClientSchema>
