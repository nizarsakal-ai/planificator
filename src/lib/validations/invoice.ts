import { z } from "zod"

export const invoiceLineSchema = z.object({
  articleId:   z.string().optional().nullable(),
  designation: z.string().min(1, "La désignation est requise").max(200),
  unit:        z.string().min(1).max(20).default("u"),
  quantity:    z.coerce.number().min(0, "Quantité invalide"),
  unitPrice:   z.coerce.number().min(0, "Prix invalide"),
  vatRate:     z.coerce.number().min(0).max(100),
})

export const createInvoiceSchema = z.object({
  worksiteId: z.string().min(1, "Le chantier est requis"),
  dueDate:    z.string().optional().nullable(),
  notes:      z.string().max(1000).optional().nullable(),
  quoteId:    z.string().optional().nullable(),
  lines:      z.array(invoiceLineSchema).default([]),
})

export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>
