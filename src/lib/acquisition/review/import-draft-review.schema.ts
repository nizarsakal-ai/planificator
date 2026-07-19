/**
 * PLAN-ACQ-005C-MVP — Schémas Zod revue (strict).
 */

import { z } from "zod"
import type { WorksiteImportDraftStatus } from "@prisma/client"

export const REVIEW_STATUSES = [
  "PENDING_EXTRACTION",
  "EXTRACTING",
  "PENDING_REVIEW",
  "FAILED",
  "APPROVED",
  "REJECTED",
  "CONVERTED",
] as const satisfies readonly WorksiteImportDraftStatus[]

export const reviewStatusFilterSchema = z.enum(REVIEW_STATUSES)

const nullableTrimmed = (max: number) =>
  z.preprocess((v) => {
    if (v === null || v === undefined) return null
    if (typeof v !== "string") return v
    const t = v.trim()
    return t.length === 0 ? null : t
  }, z.union([z.string().min(1).max(max), z.null()]))

const optionalDateYmd = z.preprocess((v) => {
  if (v === null || v === undefined) return null
  if (typeof v !== "string") return v
  const t = v.trim()
  return t.length === 0 ? null : t
}, z.union([
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "DATE_FORMAT")
    .refine((v) => {
      const d = new Date(`${v}T00:00:00.000Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
    }, "DATE_INVALID"),
  z.null(),
]))

export const saveImportDraftCorrectionsSchema = z
  .object({
    draftId: z.string().min(1).max(64),
    expectedVersion: z.number().int().min(0),
    proposedWorksiteName: nullableTrimmed(100),
    proposedClientName: nullableTrimmed(100),
    proposedAddress: nullableTrimmed(500),
    proposedPostalCode: nullableTrimmed(16),
    proposedCity: nullableTrimmed(100),
    proposedStartDate: optionalDateYmd,
    proposedEndDate: optionalDateYmd,
    proposedDescription: nullableTrimmed(5000),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.proposedStartDate && data.proposedEndDate) {
      if (data.proposedStartDate > data.proposedEndDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "DATE_RANGE_INVALID",
          path: ["proposedEndDate"],
        })
      }
    }
  })

export type SaveImportDraftCorrectionsInput = z.infer<typeof saveImportDraftCorrectionsSchema>

export const approveImportDraftSchema = z
  .object({
    draftId: z.string().min(1).max(64),
    expectedVersion: z.number().int().min(0),
  })
  .strict()

export type ApproveImportDraftInput = z.infer<typeof approveImportDraftSchema>

export const rejectImportDraftSchema = z
  .object({
    draftId: z.string().min(1).max(64),
    expectedVersion: z.number().int().min(0),
    rejectionReason: z.string().trim().min(5).max(500),
  })
  .strict()

export type RejectImportDraftInput = z.infer<typeof rejectImportDraftSchema>

export const reExtractImportDraftSchema = z
  .object({
    draftId: z.string().min(1).max(64),
  })
  .strict()

export type ReExtractImportDraftInput = z.infer<typeof reExtractImportDraftSchema>
