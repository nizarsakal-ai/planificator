/**
 * PLAN-ACQ-012-LOT-1.5 — Validation Zod stricte des entrées d’administration.
 *
 * Domaines : uniquement trim + lowercase, puis refus des formats non-domaine
 * (pas de conversion URL/email). Égalité exacte sur `domainNormalized`.
 */

import { z } from "zod"

const companyIdSchema = z.string().min(1, "companyId requis")

/** Code partenaire : trim + lowercase, non vide, slug stable. */
export const partnerCodeSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "code partenaire vide")
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "code partenaire invalide (slug a-z0-9-)"
      )
  )

export const partnerNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "nom partenaire vide").max(200))

/** Domaine : trim + lowercase ; forme labels.domaine (pas d’email). */
export const domainInputSchema = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1, "domaine vide")
      .max(253)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
        "domaine invalide"
      )
  )

export const createPartnerSchema = z
  .object({
    companyId: companyIdSchema,
    name: partnerNameSchema,
    code: partnerCodeSchema,
    connector: z.enum(["GMAIL"]).optional(),
    pipeline: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    active: z.boolean().optional(),
  })
  .strict()

export const addDomainSchema = z
  .object({
    companyId: companyIdSchema,
    partnerId: z.string().min(1),
    domain: domainInputSchema,
    active: z.boolean().optional(),
  })
  .strict()

export const partnerRefSchema = z
  .object({
    companyId: companyIdSchema,
    partnerId: z.string().min(1),
  })
  .strict()

export const domainRefSchema = z
  .object({
    companyId: companyIdSchema,
    domainId: z.string().min(1),
  })
  .strict()

export const renamePartnerSchema = z
  .object({
    companyId: companyIdSchema,
    partnerId: z.string().min(1),
    name: partnerNameSchema,
  })
  .strict()

export type CreatePartnerParsed = z.infer<typeof createPartnerSchema>
export type AddDomainParsed = z.infer<typeof addDomainSchema>
export type PartnerRefParsed = z.infer<typeof partnerRefSchema>
export type DomainRefParsed = z.infer<typeof domainRefSchema>
export type RenamePartnerParsed = z.infer<typeof renamePartnerSchema>
