/**
 * Résilience de la synchronisation Gmail Acquisition (incident 03→16/11/2026).
 *
 * 1. Un e-mail impossible à enregistrer ne doit plus bloquer la boîte indéfiniment
 *    (curseur jamais avancé → aucune consultation ingérée après lui).
 * 2. Le mapper borne les champs au schéma de validation (sujet, nom de PJ, nombre de PJ…).
 * 3. Le callback OAuth refuse un jeton sans scope gmail.readonly (consentement granulaire Google).
 * 4. La santé de la boîte est visible (plus de « active » trompeur).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { z } from "zod"
import {
  syncAcquisitionMailForCompany,
  isDeterministicIngestionError,
  MESSAGE_INGESTION_CIRCUIT_BREAKER_THRESHOLD,
} from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import {
  mapGmailMessageToAcquisitionInput,
  truncateFilename,
  MAPPER_LIMITS,
} from "@/lib/acquisition/connector/gmail-message.mapper"
import { registerIncomingMessageSchema } from "@/lib/validations/acquisition"
import {
  handleAcquisitionGmailCallback,
  hasGrantedAcquisitionGmailScope,
} from "@/lib/acquisition/connector/acquisition-gmail-oauth-callback"
import { signGmailOAuthPayload } from "@/lib/auth/gmail-oauth-state"
import {
  assessAcquisitionMailboxHealth,
  acquisitionGmailOAuthErrorMessage,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"
import type { MailProviderPort } from "@/lib/acquisition/ports/mail-provider.port"
import type { AcquisitionIngestionPort } from "@/lib/acquisition/ports/acquisition-ingestion.port"
import type {
  AcquisitionScanCursorRecord,
  AcquisitionScanCursorRepositoryPort,
} from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"
import type { CanonicalMailMessage, MailPage } from "@/lib/acquisition/connector/connector.types"

const COMPANY = "company-resilience"
const NOW = new Date("2026-11-16T08:00:00.000Z")

function mail(overrides: Partial<CanonicalMailMessage> = {}): CanonicalMailMessage {
  return {
    externalMessageId: "msg-1",
    threadId: "t-1",
    fromHeader: "user@lauralu.fr",
    subject: "Consultation",
    receivedAt: NOW,
    labels: ["INBOX"],
    snippet: null,
    attachments: [],
    providerMetadata: {},
    ...overrides,
  }
}

function page(messages: CanonicalMailMessage[], nextHistoryId: string | null): MailPage {
  return { messages, nextPageToken: null, nextHistoryId, hasMore: false, paginationMode: "history" }
}

function provider(pages: MailPage[]): MailProviderPort {
  let i = 0
  return { source: "GMAIL", listMessagesPage: async () => pages[i++] ?? page([], null) }
}

function cursorRepo(initial: Partial<AcquisitionScanCursorRecord> = {}) {
  let cursor: AcquisitionScanCursorRecord = {
    id: "cur-1",
    companyId: COMPANY,
    source: "GMAIL",
    mailboxKey: "conn-1",
    lastHistoryId: "hist-0",
    lastSyncedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    ...initial,
  }
  const failures: string[] = []
  let saves = 0
  const repo: AcquisitionScanCursorRepositoryPort = {
    getOrCreate: async () => ({ ...cursor }),
    saveSuccessfulPage: async (_c, _s, nextHistoryId, syncedAt) => {
      saves++
      cursor = { ...cursor, lastHistoryId: nextHistoryId, lastSyncedAt: syncedAt, consecutiveFailures: 0, lastErrorCode: null, lastErrorAt: null }
      return { ...cursor }
    },
    recordFailure: async (_c, _s, errorCode, occurredAt) => {
      failures.push(errorCode)
      cursor = { ...cursor, consecutiveFailures: cursor.consecutiveFailures + 1, lastErrorCode: errorCode, lastErrorAt: occurredAt }
      return { ...cursor }
    },
  }
  return { repo, getCursor: () => cursor, failures, getSaves: () => saves }
}

/** Ingestion qui délègue au vrai schéma Zod (reproduit un rejet de validation réel). */
function ingestion(handler: (id: string, input: unknown) => void = () => {}) {
  const ingested: string[] = []
  const port: AcquisitionIngestionPort = {
    isEnabled: () => true,
    registerIncomingMessage: async (input) => {
      handler(input.externalMessageId, input)
      registerIncomingMessageSchema.parse(input)
      ingested.push(input.externalMessageId)
      return { created: true, outcome: "DRAFT_CREATED", messageId: `m-${input.externalMessageId}`, draftId: `d-${input.externalMessageId}` }
    },
  }
  return { port, ingested }
}

function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const { error, warn } = console
  console.error = () => {}
  console.warn = () => {}
  return fn().finally(() => {
    console.error = error
    console.warn = warn
  })
}

describe("sync Gmail — message empoisonné", () => {
  it("erreur déterministe (Zod) : message mis en quarantaine, les suivants ingérés, curseur avancé", async () => {
    const { repo, getCursor, failures } = cursorRepo()
    const { port, ingested } = ingestion((id) => {
      if (id === "poison") z.object({ subject: z.string().max(1) }).parse({ subject: "trop long" })
    })

    const result = await silenceConsole(() =>
      syncAcquisitionMailForCompany({
        companyId: COMPANY,
        connectionId: "conn-1",
        provider: provider([page([mail({ externalMessageId: "a" }), mail({ externalMessageId: "poison" }), mail({ externalMessageId: "b" })], "hist-1")]),
        ingestion: port,
        cursorRepository: repo,
        now: () => NOW,
        mailShadow: false,
      })
    )

    assert.deepEqual(ingested, ["a", "b"])
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_QUARANTINED")
    assert.equal(result.stats.failed, 1)
    assert.equal(getCursor().lastHistoryId, "hist-1", "le curseur doit avancer malgré le message invalide")
    assert.deepEqual(failures, [])
  })

  it("erreur transitoire : arrêt sans avancer le curseur + échec persisté MESSAGE_INGESTION_FAILED", async () => {
    const { repo, getCursor, failures } = cursorRepo()
    const { port, ingested } = ingestion((id) => {
      if (id === "flaky") throw Object.assign(new Error("db down"), { code: "P1001" })
    })

    const result = await silenceConsole(() =>
      syncAcquisitionMailForCompany({
        companyId: COMPANY,
        connectionId: "conn-1",
        provider: provider([page([mail({ externalMessageId: "flaky" }), mail({ externalMessageId: "b" })], "hist-1")]),
        ingestion: port,
        cursorRepository: repo,
        now: () => NOW,
        mailShadow: false,
      })
    )

    assert.deepEqual(ingested, [])
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(result.error?.internalCode, "P1001")
    assert.equal(getCursor().lastHistoryId, "hist-0")
    assert.deepEqual(failures, ["MESSAGE_INGESTION_FAILED"])
  })

  it("disjoncteur : après N runs bloqués, même une erreur transitoire est mise en quarantaine", async () => {
    const { repo, getCursor } = cursorRepo({
      lastErrorCode: "MESSAGE_INGESTION_FAILED",
      consecutiveFailures: MESSAGE_INGESTION_CIRCUIT_BREAKER_THRESHOLD,
    })
    const { port, ingested } = ingestion((id) => {
      if (id === "stuck") throw new Error("toujours en échec")
    })

    const result = await silenceConsole(() =>
      syncAcquisitionMailForCompany({
        companyId: COMPANY,
        connectionId: "conn-1",
        provider: provider([page([mail({ externalMessageId: "stuck" }), mail({ externalMessageId: "b" })], "hist-9")]),
        ingestion: port,
        cursorRepository: repo,
        now: () => NOW,
        mailShadow: false,
      })
    )

    assert.deepEqual(ingested, ["b"])
    assert.equal(result.partialReason, "MESSAGE_QUARANTINED")
    assert.equal(getCursor().lastHistoryId, "hist-9")
    assert.equal(getCursor().consecutiveFailures, 0)
  })

  it("disjoncteur non déclenché par des échecs d'un autre type (ex. accès Gmail)", async () => {
    const { repo, getCursor } = cursorRepo({
      lastErrorCode: "PROVIDER_LIST_FAILED",
      consecutiveFailures: 50,
    })
    const { port } = ingestion((id) => {
      if (id === "flaky") throw new Error("transitoire")
    })

    const result = await silenceConsole(() =>
      syncAcquisitionMailForCompany({
        companyId: COMPANY,
        connectionId: "conn-1",
        provider: provider([page([mail({ externalMessageId: "flaky" })], "hist-1")]),
        ingestion: port,
        cursorRepository: repo,
        now: () => NOW,
        mailShadow: false,
      })
    )

    assert.equal(result.partialReason, "MESSAGE_INGESTION_FAILED")
    assert.equal(getCursor().lastHistoryId, "hist-0")
  })

  it("succès sans nouveau historyId : lastSyncedAt rafraîchi, curseur conservé, échecs remis à zéro", async () => {
    const { repo, getCursor, getSaves } = cursorRepo({ consecutiveFailures: 2, lastErrorCode: "PROVIDER_LIST_FAILED" })
    const { port } = ingestion()

    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY,
      connectionId: "conn-1",
      provider: provider([page([], null)]),
      ingestion: port,
      cursorRepository: repo,
      now: () => NOW,
      mailShadow: false,
    })

    assert.equal(result.status, "SUCCESS")
    assert.equal(getSaves(), 1)
    assert.equal(getCursor().lastHistoryId, "hist-0", "null = inchangé, jamais d'effacement du curseur")
    assert.equal(getCursor().lastSyncedAt?.toISOString(), NOW.toISOString())
    assert.equal(getCursor().consecutiveFailures, 0)
  })

  it("classification des erreurs", () => {
    assert.equal(isDeterministicIngestionError(Object.assign(new Error("x"), { name: "ZodError" })), true)
    assert.equal(isDeterministicIngestionError(Object.assign(new Error("x"), { name: "PrismaClientValidationError" })), true)
    assert.equal(isDeterministicIngestionError(Object.assign(new Error("x"), { code: "P2000" })), true)
    assert.equal(isDeterministicIngestionError(Object.assign(new Error("x"), { code: "P1001" })), false)
    assert.equal(isDeterministicIngestionError(Object.assign(new Error("x"), { code: "P2028" })), false)
    assert.equal(isDeterministicIngestionError(new Error("réseau")), false)
    assert.equal(isDeterministicIngestionError(null), false)
  })
})

describe("mapper Gmail — bornes du schéma", () => {
  it("un e-mail réel aux champs hors bornes produit une entrée valide", () => {
    const longName = `${"Justificatif de location et régularisation - Bon de commande_Chantier PGS PERURENA ".repeat(5)}.pdf`
    const input = mapGmailMessageToAcquisitionInput(
      mail({
        subject: "RE: ".repeat(200) + "DEMANDE INTERVENANTS",
        fromHeader: "",
        threadId: "",
        labels: Array.from({ length: 400 }, (_, i) => `Label_${i}_${"x".repeat(20)}`),
        snippet: "s".repeat(800),
        attachments: Array.from({ length: 60 }, (_, i) => ({
          externalAttachmentId: `att-${i}`,
          partId: i === 0 ? "9".repeat(80) : String(i),
          filename: i === 1 ? "" : longName,
          mimeType: i === 2 ? "x/" + "y".repeat(200) : "application/pdf",
          sizeBytes: i === 3 ? -5 : 12.7,
        })),
        providerMetadata: { historyId: "123" },
      }),
      COMPANY,
      "conn-1"
    )

    const parsed = registerIncomingMessageSchema.parse(input)
    assert.equal(parsed.subject.length, MAPPER_LIMITS.subject)
    assert.equal(parsed.attachments.length, MAPPER_LIMITS.attachments)
    assert.equal(parsed.threadId, null)
    assert.equal(parsed.senderEmail, "unknown-sender")
    assert.ok(parsed.attachments[0].filename.endsWith(".pdf"))
    assert.ok(parsed.attachments[0].filename.length <= MAPPER_LIMITS.filename)
    assert.equal(parsed.attachments[0].partId, undefined)
    assert.equal(parsed.attachments[1].filename, "piece-jointe")
    assert.equal(parsed.attachments[2].mimeType, "application/octet-stream")
    assert.equal(parsed.attachments[3].sizeBytes, 0)
    assert.equal(parsed.attachments[4].sizeBytes, 12)
    assert.ok(JSON.stringify(parsed.rawMetadata).length <= MAPPER_LIMITS.rawMetadataBytes)
    assert.equal((parsed.rawMetadata as Record<string, unknown>).acquisitionGmailConnectionId, "conn-1")
  })

  it("e-mail nominal inchangé (pas de troncature parasite)", () => {
    const input = mapGmailMessageToAcquisitionInput(
      mail({ attachments: [{ externalAttachmentId: "a1", partId: "2", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 100 }] }),
      COMPANY,
      "conn-1"
    )
    assert.equal(input.subject, "Consultation")
    assert.equal(input.senderEmail, "user@lauralu.fr")
    assert.equal(input.threadId, "t-1")
    assert.deepEqual(input.attachments, [{ externalAttachmentId: "a1", partId: "2", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 100 }])
    assert.deepEqual((input.rawMetadata as Record<string, unknown>).labels, ["INBOX"])
  })

  it("truncateFilename conserve l'extension et ne coupe pas un emoji", () => {
    assert.equal(truncateFilename("a".repeat(300) + ".xlsx").length, 255)
    assert.ok(truncateFilename("a".repeat(300) + ".xlsx").endsWith(".xlsx"))
    assert.equal(truncateFilename("  "), "piece-jointe")
    const emoji = truncateFilename("😀".repeat(300), 10)
    assert.equal(Array.from(emoji).length, 10)
    assert.ok(!emoji.includes("�"))
  })
})

describe("callback OAuth Acquisition — scope Gmail obligatoire", () => {
  const secret = "test-secret-scope"
  const payload = JSON.stringify({ purpose: "acquisition_gmail", companyId: COMPANY, userId: "user-1" })
  const state = Buffer.from(JSON.stringify({ payload, sig: signGmailOAuthPayload(payload, secret) }), "utf8").toString("base64url")

  async function callback(scope: string | undefined) {
    let upserts = 0
    const res = await handleAcquisitionGmailCallback(
      { nextUrl: { searchParams: new URLSearchParams({ code: "code", state }) } } as never,
      {
        auth: async () => ({ user: { id: "user-1", companyId: COMPANY, role: "ADMIN" } }),
        prisma: { acquisitionGmailConnection: { upsert: async () => { upserts++; return {} } } } as never,
        fetch: (async (url: string) => {
          if (String(url).includes("oauth2.googleapis.com/token")) {
            return { ok: true, json: async () => ({ access_token: "at", refresh_token: "rt", expires_in: 3600, ...(scope !== undefined ? { scope } : {}) }) }
          }
          return { ok: true, json: async () => ({ email: "Galyaevents1@gmail.com" }) }
        }) as never,
        resolveRedirectUri: () => "https://app.example/api/acquisition/gmail/callback",
        resolveHmacSecret: () => secret,
        encrypt: (v: string) => `enc:${v}`,
        appUrl: "https://app.example",
        env: { ...process.env, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csec" },
      }
    )
    return { location: String(res.headers.get("location")), upserts }
  }

  it("scope Gmail décoché sur l'écran Google → missing_gmail_scope, aucune écriture", async () => {
    const { location, upserts } = await silenceConsole(() =>
      callback("https://www.googleapis.com/auth/userinfo.email openid")
    )
    assert.ok(location.includes("acquisition_gmail=error"))
    assert.ok(location.includes("reason=missing_gmail_scope"))
    assert.equal(upserts, 0)
  })

  it("scope absent de la réponse → refus (pas de connexion « active » invérifiable)", async () => {
    const { location, upserts } = await silenceConsole(() => callback(undefined))
    assert.ok(location.includes("reason=missing_gmail_scope"))
    assert.equal(upserts, 0)
  })

  it("scope Gmail accordé → connexion enregistrée", async () => {
    const { location, upserts } = await callback(
      "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly"
    )
    assert.ok(location.includes("acquisition_gmail=connected"))
    assert.equal(upserts, 1)
  })

  it("hasGrantedAcquisitionGmailScope n'accepte pas un scope voisin", () => {
    assert.equal(hasGrantedAcquisitionGmailScope("https://www.googleapis.com/auth/gmail.readonly"), true)
    assert.equal(hasGrantedAcquisitionGmailScope("https://www.googleapis.com/auth/gmail.readonly.extra"), false)
    assert.equal(hasGrantedAcquisitionGmailScope("https://www.googleapis.com/auth/drive.file"), false)
    assert.equal(hasGrantedAcquisitionGmailScope(42), false)
  })

  it("message utilisateur explicite pour missing_gmail_scope", () => {
    assert.match(acquisitionGmailOAuthErrorMessage("missing_gmail_scope"), /cochez/)
    assert.equal(acquisitionGmailOAuthErrorMessage(undefined), "Échec de la connexion Gmail Acquisition.")
  })
})

describe("santé d'une boîte Acquisition", () => {
  const cursor = (o: Partial<Parameters<typeof assessAcquisitionMailboxHealth>[0]["cursor"] & object> = {}) => ({
    lastSyncedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorAt: null,
    ...o,
  })

  it("accès Gmail refusé en continu → reconnexion requise (plus jamais « active »)", () => {
    const h = assessAcquisitionMailboxHealth({
      active: true,
      cursor: cursor({ consecutiveFailures: 14, lastErrorCode: "PROVIDER_LIST_FAILED", lastErrorAt: new Date("2026-11-16T07:00:00Z") }),
      connectionUpdatedAt: new Date("2026-11-15T14:00:00Z"),
      now: NOW,
    })
    assert.equal(h.level, "error")
    assert.equal(h.label, "reconnexion requise")
  })

  it("échecs antérieurs à une reconnexion → en attente, pas d'alerte", () => {
    const h = assessAcquisitionMailboxHealth({
      active: true,
      cursor: cursor({ consecutiveFailures: 14, lastErrorCode: "PROVIDER_LIST_FAILED", lastErrorAt: new Date("2026-11-16T07:00:00Z") }),
      connectionUpdatedAt: new Date("2026-11-16T07:30:00Z"),
      now: NOW,
    })
    assert.equal(h.level, "pending")
  })

  it("premier échec → avertissement ; blocage message → avertissement dédié", () => {
    assert.equal(assessAcquisitionMailboxHealth({ active: true, cursor: cursor({ consecutiveFailures: 1, lastErrorCode: "PROVIDER_LIST_FAILED" }), now: NOW }).level, "warning")
    const blocked = assessAcquisitionMailboxHealth({ active: true, cursor: cursor({ consecutiveFailures: 3, lastErrorCode: "MESSAGE_INGESTION_FAILED" }), now: NOW })
    assert.equal(blocked.level, "warning")
    assert.equal(blocked.label, "synchronisation ralentie")
  })

  it("synchro récente → ok ; synchro ancienne → avertissement ; jamais synchronisée → en attente", () => {
    assert.deepEqual(
      assessAcquisitionMailboxHealth({ active: true, cursor: cursor({ lastSyncedAt: new Date("2026-11-16T07:45:00Z") }), now: NOW }),
      { level: "ok", label: "synchronisée il y a 15 min" }
    )
    assert.equal(assessAcquisitionMailboxHealth({ active: true, cursor: cursor({ lastSyncedAt: new Date("2026-11-15T08:00:00Z") }), now: NOW }).level, "warning")
    assert.equal(assessAcquisitionMailboxHealth({ active: true, cursor: null, now: NOW }).level, "pending")
    assert.equal(assessAcquisitionMailboxHealth({ active: false, cursor: null, now: NOW }).level, "inactive")
  })
})
