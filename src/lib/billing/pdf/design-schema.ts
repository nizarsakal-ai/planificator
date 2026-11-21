// 20/11/2026 — schéma zod d'un design saisi (forme seulement ; lisibilité et couleurs contrôlées par validateDesign).
import { z } from "zod"
import { PDF_LAYOUTS, PDF_TEMPLATES } from "./design"

export const designInputSchema = z.object({
  template: z.enum(PDF_TEMPLATES),
  primary: z.string().trim().max(9),
  secondary: z.string().trim().max(9),
  layout: z.enum(PDF_LAYOUTS),
  showClientIds: z.boolean(),
  showBankDetails: z.boolean(),
}).strict()
