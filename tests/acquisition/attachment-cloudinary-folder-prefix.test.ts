process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_ENV,
  DEFAULT_ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX,
  buildAcquisitionAttachmentCloudinaryFolder,
  resolveAcquisitionAttachmentCloudinaryFolderPrefix,
} from "@/lib/acquisition/attachments/attachment-cloudinary-folder-prefix"

const ENV_KEY = ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_ENV

describe("resolveAcquisitionAttachmentCloudinaryFolderPrefix", () => {
  const previous = process.env[ENV_KEY]

  beforeEach(() => {
    delete process.env[ENV_KEY]
  })

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = previous
  })

  it("variable absente → planificator", () => {
    delete process.env[ENV_KEY]
    assert.equal(
      resolveAcquisitionAttachmentCloudinaryFolderPrefix(),
      DEFAULT_ACQUISITION_ATTACHMENT_CLOUDINARY_FOLDER_PREFIX
    )
    assert.equal(resolveAcquisitionAttachmentCloudinaryFolderPrefix(undefined), "planificator")
  })

  it("variable vide ou espaces → ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID", () => {
    process.env[ENV_KEY] = ""
    assert.throws(
      () => resolveAcquisitionAttachmentCloudinaryFolderPrefix(),
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
    assert.throws(
      () => resolveAcquisitionAttachmentCloudinaryFolderPrefix(""),
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
    assert.throws(
      () => resolveAcquisitionAttachmentCloudinaryFolderPrefix("   "),
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
  })

  it("trim externe accepté", () => {
    assert.equal(
      resolveAcquisitionAttachmentCloudinaryFolderPrefix("  planificator-staging  "),
      "planificator-staging"
    )
  })

  it("planificator-staging accepté", () => {
    process.env[ENV_KEY] = "planificator-staging"
    assert.equal(resolveAcquisitionAttachmentCloudinaryFolderPrefix(), "planificator-staging")
  })

  it("comportement Production historique inchangé (défaut planificator)", () => {
    delete process.env[ENV_KEY]
    const folder = buildAcquisitionAttachmentCloudinaryFolder({
      companyId: "co-1",
      acquisitionMessageId: "msg-1",
      attachmentId: "att-1",
    })
    assert.equal(folder, "planificator/co-1/acquisition/msg-1/att-1")
  })

  it("chemin exact du nouvel upload staging", () => {
    process.env[ENV_KEY] = "planificator-staging"
    const folder = buildAcquisitionAttachmentCloudinaryFolder({
      companyId: "companyId",
      acquisitionMessageId: "acquisitionMessageId",
      attachmentId: "attachmentId",
    })
    assert.equal(
      folder,
      "planificator-staging/companyId/acquisition/acquisitionMessageId/attachmentId"
    )
  })

  it("isolation logique entre préfixes", () => {
    const prod = buildAcquisitionAttachmentCloudinaryFolder({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      folderPrefix: "planificator",
    })
    const staging = buildAcquisitionAttachmentCloudinaryFolder({
      companyId: "co",
      acquisitionMessageId: "msg",
      attachmentId: "att",
      folderPrefix: "planificator-staging",
    })
    assert.notEqual(prod, staging)
    assert.equal(prod.startsWith("planificator/"), true)
    assert.equal(staging.startsWith("planificator-staging/"), true)
    assert.equal(prod.includes("planificator-staging"), false)
  })

  it("préfixe explicite invalide rejeté (même validation que l'env)", () => {
    assert.throws(
      () =>
        buildAcquisitionAttachmentCloudinaryFolder({
          companyId: "co",
          acquisitionMessageId: "msg",
          attachmentId: "att",
          folderPrefix: "Planificator/Staging",
        }),
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
    assert.throws(
      () =>
        buildAcquisitionAttachmentCloudinaryFolder({
          companyId: "co",
          acquisitionMessageId: "msg",
          attachmentId: "att",
          folderPrefix: "-leading",
        }),
      /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/
    )
  })

  it("valeurs invalides rejetées", () => {
    const invalid = [
      "Planificator",
      "planificator/staging",
      "planificator\\staging",
      "planificator..staging",
      "planificator staging",
      "planificator_staging",
      "planificator.staging",
      "../etc",
      "a/b",
      "UPPER",
      "with space",
      "ok!",
      "-leading",
      "trailing-",
      "double--dash",
    ]
    for (const value of invalid) {
      assert.throws(
        () => resolveAcquisitionAttachmentCloudinaryFolderPrefix(value),
        /ATTACHMENT_CLOUDINARY_FOLDER_PREFIX_INVALID/,
        `expected reject for ${JSON.stringify(value)}`
      )
    }
  })

  it("ne dépend pas de NODE_ENV / VERCEL_ENV", () => {
    const env = process.env as Record<string, string | undefined>
    const nodeEnv = env.NODE_ENV
    const vercelEnv = env.VERCEL_ENV
    try {
      env.NODE_ENV = "production"
      env.VERCEL_ENV = "preview"
      delete process.env[ENV_KEY]
      assert.equal(resolveAcquisitionAttachmentCloudinaryFolderPrefix(), "planificator")
      process.env[ENV_KEY] = "planificator-staging"
      assert.equal(resolveAcquisitionAttachmentCloudinaryFolderPrefix(), "planificator-staging")
    } finally {
      if (nodeEnv === undefined) delete env.NODE_ENV
      else env.NODE_ENV = nodeEnv
      if (vercelEnv === undefined) delete env.VERCEL_ENV
      else env.VERCEL_ENV = vercelEnv
    }
  })
})
