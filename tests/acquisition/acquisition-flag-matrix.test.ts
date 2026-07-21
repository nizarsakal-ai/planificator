/**
 * PLAN-ACQ-OPS-001 — Tests matrice flags & gates.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  getAcquisitionFlagMatrix,
  resolveAcquisitionAttachmentDownloadCronGate,
  resolveAcquisitionAttachmentRecoveryCronGate,
  resolveAcquisitionGmailCronGate,
  validateAcquisitionFlagMatrix,
  type AcquisitionFlagIssueCode,
} from "@/lib/acquisition/acquisition-flag-matrix"
import { getExtractionProviderId } from "@/lib/acquisition/extraction/extraction-feature-flag"

const FLAG_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_GMAIL_CRON_ENABLED",
  "ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED",
  "ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED",
  "ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED",
  "ACQUISITION_ATTACHMENT_ACCESS_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_EXTRACTION_ENABLED",
  "ACQUISITION_EXTRACTION_PROVIDER",
  "ACQUISITION_CONVERSION_ENABLED",
] as const

function issueCodes(): AcquisitionFlagIssueCode[] {
  return validateAcquisitionFlagMatrix().map((i) => i.code)
}

function assertExactIssues(expected: AcquisitionFlagIssueCode[]) {
  const codes = issueCodes().sort()
  assert.deepEqual(codes, [...expected].sort())
  const serialized = JSON.stringify(validateAcquisitionFlagMatrix())
  assert.ok(!serialized.includes("Bearer"))
  assert.ok(!serialized.includes("sk-"))
  assert.ok(!serialized.includes("ANTHROPIC"))
}

describe("acquisition-flag-matrix", () => {
  const backup: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of FLAG_KEYS) {
      backup[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  it("absent / false / TRUE → false ; true → true", () => {
    assert.equal(getAcquisitionFlagMatrix().master, false)
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "false"
    assert.equal(getAcquisitionFlagMatrix().master, false)
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "TRUE"
    assert.equal(getAcquisitionFlagMatrix().master, false)
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    assert.equal(getAcquisitionFlagMatrix().master, true)
  })

  it("provider absent → deterministic", () => {
    assert.equal(getExtractionProviderId(), "deterministic")
  })

  it("INV: Gmail cron ON + master OFF", () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    assertExactIssues(["INV_GMAIL_CRON_WITHOUT_MASTER"])
  })

  it("INV: download capability ON + master OFF", () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    assertExactIssues(["INV_DOWNLOAD_WITHOUT_MASTER"])
  })

  it("INV: download cron ON + master OFF", () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    assertExactIssues([
      "INV_DOWNLOAD_CRON_WITHOUT_MASTER",
      "INV_DOWNLOAD_CRON_WITHOUT_CAPABILITY",
    ])
  })

  it("INV: download cron ON + download capability OFF (master ON)", () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    assertExactIssues(["INV_DOWNLOAD_CRON_WITHOUT_CAPABILITY"])
  })

  it("INV: recovery ON + master OFF", () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    assertExactIssues([
      "INV_RECOVERY_WITHOUT_MASTER",
      "INV_RECOVERY_WITHOUT_DOWNLOAD",
    ])
  })

  it("INV: recovery ON + download OFF (master ON)", () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    assertExactIssues(["INV_RECOVERY_WITHOUT_DOWNLOAD"])
  })

  it("INV: content ON + master OFF", () => {
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    assertExactIssues(["INV_CONTENT_WITHOUT_MASTER"])
  })

  it("INV: extraction ON + master OFF", () => {
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    assertExactIssues([
      "INV_EXTRACTION_WITHOUT_MASTER",
      "INV_EXTRACTION_WITHOUT_CONTENT",
    ])
  })

  it("INV: extraction ON + content OFF (master ON)", () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    assertExactIssues(["INV_EXTRACTION_WITHOUT_CONTENT"])
  })

  it("INV: access ON + master OFF", () => {
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "true"
    assertExactIssues(["INV_ACCESS_WITHOUT_MASTER"])
  })

  it("INV: conversion ON + master OFF", () => {
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
    const m = getAcquisitionFlagMatrix()
    assert.equal(m.conversion, true)
    assert.equal(m.conversionFully, false)
    assertExactIssues(["INV_CONVERSION_WITHOUT_MASTER"])
  })

  it("gate gmail: cron ON + master OFF → MASTER_DISABLED", () => {
    process.env.ACQUISITION_GMAIL_CRON_ENABLED = "true"
    assert.deepEqual(resolveAcquisitionGmailCronGate(), {
      allowed: false,
      skipReason: "MASTER_DISABLED",
    })
  })

  it("gate download cron: ON + download OFF → DOWNLOAD_CAPABILITY_DISABLED", () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    assert.deepEqual(resolveAcquisitionAttachmentDownloadCronGate(), {
      allowed: false,
      skipReason: "DOWNLOAD_CAPABILITY_DISABLED",
    })
  })

  it("gate recovery: ON + master OFF → MASTER_DISABLED", () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    assert.deepEqual(resolveAcquisitionAttachmentRecoveryCronGate(), {
      allowed: false,
      skipReason: "MASTER_DISABLED",
    })
  })

  it("gate recovery: ON + master ON + download OFF → DOWNLOAD_CAPABILITY_DISABLED", () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    assert.deepEqual(resolveAcquisitionAttachmentRecoveryCronGate(), {
      allowed: false,
      skipReason: "DOWNLOAD_CAPABILITY_DISABLED",
    })
  })
})
