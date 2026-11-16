/**
 * Boîte Gmail Consultations inaccessible : alerte e-mail, hook de synchro,
 * bouton « Reconnecter » (login_hint) et bandeau sur la page Consultations.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
// tsconfig "jsx": "preserve" → sous tsx, JSX compilé en React.createElement (runtime classique).
;(globalThis as { React?: typeof React }).React = React
import {
  notifyAcquisitionMailboxAccessLost,
  shouldSendMailboxAlert,
  type MailboxAlertDeps,
} from "@/lib/acquisition/connector/acquisition-mailbox-alert"
import { syncAcquisitionMailForCompany } from "@/lib/acquisition/connector/acquisition-gmail-sync.service"
import {
  acquisitionGmailReconnectUrl,
  mailboxNeedsReconnect,
  parseLoginHint,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"
import { loadAcquisitionMailboxStatuses } from "@/lib/acquisition/connector/acquisition-mailbox-health.repository"
import { MailboxHealthBanner } from "@/components/consultations/MailboxHealthBanner"
import type { AcquisitionScanCursorRecord } from "@/lib/acquisition/persistence/acquisition-scan-cursor.repository"


const COMPANY = "company-alert"
const NOW = new Date("2026-11-16T13:00:00.000Z")

describe("planning des alertes", () => {
  it("1er envoi au 2e échec, puis 1 fois par jour pendant 7 jours, puis silence", () => {
    const due = Array.from({ length: 400 }, (_, i) => i).filter(shouldSendMailboxAlert)
    assert.deepEqual(due, [2, 26, 50, 74, 98, 122, 146, 170])
    assert.equal(shouldSendMailboxAlert(1), false)
    assert.equal(shouldSendMailboxAlert(0), false)
    assert.equal(shouldSendMailboxAlert(2.5), false)
  })
})

function deps(overrides: Partial<MailboxAlertDeps> = {}) {
  const sent: Array<{ to: string; gmailAddress: string; consecutiveFailures: number; companyName: string }> = []
  const logs: string[] = []
  const d: MailboxAlertDeps = {
    listAdmins: async () => [{ email: "Admin@Galya.fr" }, { email: "admin@galya.fr" }, { email: "boss@galya.fr" }],
    getCompanyName: async () => "GALYA EVENTS",
    sendEmail: async (input) => {
      sent.push(input)
    },
    log: (event) => logs.push(event),
    ...overrides,
  }
  return { d, sent, logs }
}

describe("notifyAcquisitionMailboxAccessLost", () => {
  it("envoie un e-mail par administrateur (dédoublonné) au moment prévu", async () => {
    const { d, sent } = deps()
    const r = await notifyAcquisitionMailboxAccessLost(
      { companyId: COMPANY, gmailAddress: "galyaevents1@gmail.com", consecutiveFailures: 2 },
      d
    )
    assert.deepEqual(r, { sent: 2, failed: 0 })
    assert.deepEqual(sent.map((s) => s.to).sort(), ["admin@galya.fr", "boss@galya.fr"])
    assert.equal(sent[0].companyName, "GALYA EVENTS")
    assert.equal(sent[0].gmailAddress, "galyaevents1@gmail.com")
  })

  it("hors calendrier → aucun envoi ni lecture", async () => {
    let lookups = 0
    const { d, sent } = deps({ listAdmins: async () => { lookups++; return [] } })
    const r = await notifyAcquisitionMailboxAccessLost({ companyId: COMPANY, gmailAddress: "x@gmail.com", consecutiveFailures: 3 }, d)
    assert.equal(r.skipped, "NOT_DUE")
    assert.equal(lookups, 0)
    assert.equal(sent.length, 0)
  })

  it("ne lève jamais : échec d'envoi compté, échec de lecture absorbé, aucun admin signalé", async () => {
    const failing = deps({ sendEmail: async () => { throw new Error("RESEND_DOWN") } })
    assert.deepEqual(
      await notifyAcquisitionMailboxAccessLost({ companyId: COMPANY, gmailAddress: "x@gmail.com", consecutiveFailures: 2 }, failing.d),
      { sent: 0, failed: 2 }
    )
    assert.ok(failing.logs.includes("MAILBOX_ALERT_SEND_FAILED"))

    const lookup = deps({ listAdmins: async () => { throw new Error("db") } })
    assert.deepEqual(
      await notifyAcquisitionMailboxAccessLost({ companyId: COMPANY, gmailAddress: "x@gmail.com", consecutiveFailures: 26 }, lookup.d),
      { sent: 0, failed: 1 }
    )

    const none = deps({ listAdmins: async () => [] })
    const r = await notifyAcquisitionMailboxAccessLost({ companyId: COMPANY, gmailAddress: "x@gmail.com", consecutiveFailures: 2 }, none.d)
    assert.equal(r.skipped, "NO_ADMIN")
  })
})

function cursorRepo(consecutiveFailures: number) {
  let cursor: AcquisitionScanCursorRecord = {
    id: "c1", companyId: COMPANY, source: "GMAIL", mailboxKey: "conn-1", lastHistoryId: "h0",
    lastSyncedAt: null, consecutiveFailures, lastErrorCode: "PROVIDER_LIST_FAILED", lastErrorAt: null,
  }
  return {
    getOrCreate: async () => ({ ...cursor }),
    saveSuccessfulPage: async () => ({ ...cursor }),
    recordFailure: async (_c: string, _s: string, errorCode: string, occurredAt: Date) => {
      cursor = { ...cursor, consecutiveFailures: cursor.consecutiveFailures + 1, lastErrorCode: errorCode, lastErrorAt: occurredAt }
      return { ...cursor }
    },
  } as never
}

describe("hook de synchro onProviderAccessLost", () => {
  const ingestion = { isEnabled: () => true, registerIncomingMessage: async () => { throw new Error("unexpected") } } as never
  const failingProvider = {
    source: "GMAIL",
    listMessagesPage: async () => { throw Object.assign(new Error("403"), { code: "GMAIL_UNAUTHORIZED" }) },
  } as never

  it("appelé avec le compteur à jour après un refus Gmail", async () => {
    const calls: number[] = []
    const result = await syncAcquisitionMailForCompany({
      companyId: COMPANY, connectionId: "conn-1", provider: failingProvider, ingestion,
      cursorRepository: cursorRepo(1), now: () => NOW, mailShadow: false,
      onProviderAccessLost: async ({ consecutiveFailures }) => { calls.push(consecutiveFailures) },
    })
    assert.equal(result.status, "FAILED")
    assert.deepEqual(calls, [2])
  })

  it("une exception du hook n'altère pas le résultat de la synchro", async () => {
    const { warn } = console
    console.warn = () => {}
    try {
      const result = await syncAcquisitionMailForCompany({
        companyId: COMPANY, connectionId: "conn-1", provider: failingProvider, ingestion,
        cursorRepository: cursorRepo(1), now: () => NOW, mailShadow: false,
        onProviderAccessLost: async () => { throw new Error("mail down") },
      })
      assert.equal(result.status, "FAILED")
      assert.equal(result.error?.code, "PROVIDER_LIST_FAILED")
    } finally {
      console.warn = warn
    }
  })

  it("non appelé quand la synchro réussit", async () => {
    let called = false
    await syncAcquisitionMailForCompany({
      companyId: COMPANY, connectionId: "conn-1",
      provider: { source: "GMAIL", listMessagesPage: async () => ({ messages: [], nextPageToken: null, nextHistoryId: null, hasMore: false, paginationMode: "history" }) } as never,
      ingestion, cursorRepository: cursorRepo(0), now: () => NOW, mailShadow: false,
      onProviderAccessLost: async () => { called = true },
    })
    assert.equal(called, false)
  })
})

describe("reconnexion ciblée", () => {
  it("parseLoginHint n'accepte qu'une adresse bornée", () => {
    assert.equal(parseLoginHint(" GalyaEvents1@gmail.com "), "galyaevents1@gmail.com")
    assert.equal(parseLoginHint(null), null)
    assert.equal(parseLoginHint("pas-une-adresse"), null)
    assert.equal(parseLoginHint("a@b.c\"><script>"), null)
    assert.equal(parseLoginHint(`${"a".repeat(65)}@gmail.com`), null)
  })

  it("URL de reconnexion encodée", () => {
    assert.equal(acquisitionGmailReconnectUrl("a+b@gmail.com"), "/api/acquisition/gmail/connect?hint=a%2Bb%40gmail.com")
  })
})

describe("bandeau Consultations + chargement santé", () => {
  const db = {
    acquisitionGmailConnection: {
      findMany: async () => [
        { id: "conn-ok", gmailAddress: "ok@gmail.com", active: true, updatedAt: new Date("2026-11-01T00:00:00Z") },
        { id: "conn-ko", gmailAddress: "galyaevents1@gmail.com", active: true, updatedAt: new Date("2026-11-15T14:00:00Z") },
      ],
    },
    acquisitionScanCursor: {
      findMany: async () => [
        { mailboxKey: "conn-ok", lastSyncedAt: new Date("2026-11-16T12:30:00Z"), consecutiveFailures: 0, lastErrorCode: null, lastErrorAt: null },
        { mailboxKey: "conn-ko", lastSyncedAt: null, consecutiveFailures: 19, lastErrorCode: "PROVIDER_LIST_FAILED", lastErrorAt: new Date("2026-11-16T13:00:00Z") },
      ],
    },
  } as never

  it("seule la boîte en échec déclenche le bandeau et le bouton Reconnecter", async () => {
    const statuses = await loadAcquisitionMailboxStatuses(COMPANY, { db, now: NOW })
    assert.deepEqual(statuses.map((s) => [s.gmailAddress, s.health.level]), [
      ["ok@gmail.com", "ok"],
      ["galyaevents1@gmail.com", "error"],
    ])
    assert.deepEqual(statuses.map((s) => mailboxNeedsReconnect(s.health)), [false, true])

    const html = renderToStaticMarkup(<MailboxHealthBanner mailboxes={statuses} />)
    assert.match(html, /role="alert"/)
    assert.match(html, /galyaevents1@gmail\.com/)
    assert.match(html, /href="\/api\/acquisition\/gmail\/connect\?hint=galyaevents1%40gmail\.com"/)
    assert.doesNotMatch(html, /ok@gmail\.com/)
  })

  it("aucune boîte en échec → aucun bandeau", async () => {
    const statuses = await loadAcquisitionMailboxStatuses(COMPANY, { db, now: NOW })
    assert.equal(renderToStaticMarkup(<MailboxHealthBanner mailboxes={statuses.filter((s) => s.health.level === "ok")} />), "")
  })
})

describe("import sans effet de bord", () => {
  it("le module d'alerte se charge sans clé Resend (import paresseux de email.ts)", async () => {
    const src = (await import("node:fs")).readFileSync(
      new URL("../../src/lib/acquisition/connector/acquisition-mailbox-alert.ts", import.meta.url),
      "utf8"
    )
    assert.ok(!/^import \{[^}]*\} from "@\/lib\/email"/m.test(src), "import statique de email.ts interdit")
  })
})
