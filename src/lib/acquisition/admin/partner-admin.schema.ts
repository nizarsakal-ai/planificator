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

/**
 * Mise à jour explicite des policies partenaire (Lot F / R3).
 * Création reste défaut OFF — pas d’activation auto accidentelle à la create.
 * Au moins un champ policy doit être fourni.
 */
export const updatePartnerPolicySchema = z
  .object({
    companyId: companyIdSchema,
    partnerId: z.string().min(1),
    autoApproveEnabled: z.boolean().optional(),
    autoConvertEnabled: z.boolean().optional(),
    allowCreateClient: z.boolean().optional(),
    minConfidence: z.number().min(0).max(1).nullable().optional(),
    requireExactEmail: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.autoApproveEnabled !== undefined ||
      v.autoConvertEnabled !== undefined ||
      v.allowCreateClient !== undefined ||
      v.minConfidence !== undefined ||
      v.requireExactEmail !== undefined ||
      v.priority !== undefined,
    { message: "au moins un champ policy requis" }
  )

export type CreatePartnerParsed = z.infer<typeof createPartnerSchema>
export type AddDomainParsed = z.infer<typeof addDomainSchema>
export type PartnerRefParsed = z.infer<typeof partnerRefSchema>
export type DomainRefParsed = z.infer<typeof domainRefSchema>
export type RenamePartnerParsed = z.infer<typeof renamePartnerSchema>
export type UpdatePartnerPolicyParsed = z.infer<typeof updatePartnerPolicySchema>
