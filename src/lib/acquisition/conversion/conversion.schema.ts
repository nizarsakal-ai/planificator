/**
 * PLAN-ACQ-005D — Schémas Zod conversion (strict).
 */

import { z } from "zod"

const nullableTrimmed = (max: number) =>
  z.preprocess((v) => {
    if (v === null || v === undefined) return null
    if (typeof v !== "string") return v
    const t = v.trim()
    return t.length === 0 ? null : t
  }, z.union([z.string().min(1).max(max), z.null()]))

const requiredTrimmed = (max: number) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v
    return v.trim()
  }, z.string().min(1).max(max))

export const convertImportDraftSchema = z
  .object({
    draftId: z.string().min(1).max(64),
    expectedVersion: z.number().int().min(0),
    clientMode: z.enum(["EXISTING", "NEW"]),
    existingClientId: z.string().min(1).max(64).optional(),
    newClient: z
      .object({
        name: requiredTrimmed(100),
        email: z.preprocess((v) => {
          if (v === null || v === undefined || v === "") return null
          if (typeof v !== "string") return v
          const t = v.trim()
          return t.length === 0 ? null : t
        }, z.union([z.string().email().max(200), z.null()])),
        phone: nullableTrimmed(40),
        address: nullableTrimmed(500),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.clientMode === "EXISTING") {
      if (!data.existingClientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EXISTING_CLIENT_REQUIRED",
          path: ["existingClientId"],
        })
      }
    }
    if (data.clientMode === "NEW") {
      if (!data.newClient) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "NEW_CLIENT_REQUIRED",
          path: ["newClient"],
        })
      }
    }
  })

export type ConvertImportDraftInput = z.infer<typeof convertImportDraftSchema>
