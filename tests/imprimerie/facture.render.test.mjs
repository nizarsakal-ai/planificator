import assert from "node:assert/strict"
import { beforeEach, mock, test } from "node:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

globalThis.React = React

const companyId = "societe-fictive"
const worksiteId = "chantier-fictif"
const quoteNumber = "DEV-TEST-01"
const scope = JSON.stringify([companyId, worksiteId, quoteNumber])
const user = { id: "utilisateur-fictif", companyId, role: "ADMIN" }
const worksite = { id: worksiteId, companyId, active: true, name: "Chantier fictif" }
const quote = {
  number: quoteNumber,
  status: "ACCEPTED",
  bat: { number: "BAT-TEST-01", status: "APPROVED" },
  productionOrders: [{ number: "OF-TEST-01", status: "LIVRE", deliveredAt: "2026-11-26T10:00:00.000Z" }],
}
const invoice = {
  number: "FAC-TEST-01",
  status: "SENT",
  total: 98765.43,
  paymentMethod: "REGLEMENT-FICTIF",
  pdfUrl: "/PDF-FICTIF",
  customerEmail: "client@example.invalid",
}

let state
beforeEach(() => {
  Object.assign(process.env, {
    VERCEL_ENV: "production",
    IMPRIMERIE_PRODUCTION_ENABLED: "true",
    IMPRIMERIE_MENU_COMPANY_ID: companyId,
    IMPRIMERIE_COMPANY_ID: companyId,
    IMPRIMERIE_WORKSITE_ID: worksiteId,
    IMPRIMERIE_QUOTE_NUMBER: quoteNumber,
  })
  delete process.env.IMPRIMERIE_INVOICE_READ_SCOPE
  delete process.env.VERCEL_OIDC_TOKEN
  state = {
    user,
    worksite,
    token: "identite-fictive",
    payload: { ...quote, invoice },
    requests: [],
    worksiteReads: [],
    readOnly: false,
  }
})

mock.module("@/auth", { namedExports: { auth: async () => ({ user: state.user }) } })
mock.module("next/headers", { namedExports: {
  headers: async () => new Headers(state.token ? { "x-vercel-oidc-token": state.token } : {}),
} })
mock.module("next/navigation", { namedExports: {
  notFound() { throw new Error("Page introuvable") },
} })

mock.module("@/lib/prisma", { namedExports: { prisma: {
  $transaction: async (read) => read({
    $executeRaw: async (statement) => {
      assert.equal(statement.join(""), "SET TRANSACTION READ ONLY")
      state.readOnly = true
    },
    worksite: {
      findFirst: async ({ where, select }) => {
        assert.equal(state.readOnly, true)
        assert.deepEqual(select, { id: true, name: true })
        state.worksiteReads.push(where)
        const record = state.worksite
        return record && record.id === where.id && record.companyId === where.companyId
          && record.active === where.company.active ? { id: record.id, name: record.name } : null
      },
    },
  }),
} } })

mock.method(globalThis, "fetch", async (url, options) => {
  state.requests.push({
    url,
    headers: new Headers(options.headers),
    method: options.method ?? "GET",
    cache: options.cache,
  })
  return Response.json(state.payload)
})

const { default: ImprimeriePage } = await import("../../src/app/(dashboard)/imprimerie/page.tsx")
const render = async () => renderToStaticMarkup(await ImprimeriePage())

function assertQuoteRendered(html) {
  assert.match(html, /DEV-TEST-01/)
  assert.match(html, /BAT-TEST-01/)
  assert.match(html, /OF-TEST-01/)
  assert.match(html, /Livraison/)
}

test("le vrai rendu affiche la référence et le statut après les contrôles du dossier", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = scope
  const html = await render()

  assertQuoteRendered(html)
  assert.deepEqual(state.worksiteReads, [{ id: worksiteId, companyId, company: { active: true } }])
  assert.equal(state.requests.length, 1)
  const [request] = state.requests
  assert.equal(request.url, "https://printmanager-pro.onrender.com/api/integrations/imprimerie/devis/" + quoteNumber)
  assert.equal(request.method, "GET")
  assert.equal(request.cache, "no-store")
  assert.equal(request.headers.get("authorization"), "Bearer identite-fictive")
  assert.equal(request.headers.get("x-imprimerie-invoice-scope"), encodeURIComponent(scope))
  const row = html.match(/<dt[^>]*>Facture<\/dt>(<dd[^>]*>.*?<\/dd>)/)?.[1]
  assert.ok(row)
  assert.match(row, /FAC-TEST-01/)
  assert.match(row, /Envoyée/)
  assert.doesNotMatch(row, /<(?:a|button)\b|98765|REGLEMENT-FICTIF|PDF-FICTIF|example\.invalid/)
})

test("le devis accessible sans droit facture ne déclenche aucune demande facture et n’en affiche aucune", async () => {
  const html = await render()
  assertQuoteRendered(html)
  assert.doesNotMatch(html, /FAC-TEST-01|>Facture<\/dt>/)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].headers.has("x-imprimerie-invoice-scope"), false)
})

test("un droit pour un chantier différent ne déclenche aucune demande facture", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = JSON.stringify([companyId, "autre-chantier", quoteNumber])
  const html = await render()
  assertQuoteRendered(html)
  assert.doesNotMatch(html, /FAC-TEST-01|>Facture<\/dt>/)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].headers.has("x-imprimerie-invoice-scope"), false)
})

test("une réponse ancienne, sans facture, ou avec facture invalide conserve le reste du suivi", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = scope
  for (const payload of [
    quote,
    { ...quote, invoice: null },
    { ...quote, invoice: { number: invoice.number, status: "STATUT-INCONNU" } },
  ]) {
    state.payload = payload
    const html = await render()
    assertQuoteRendered(html)
    assert.doesNotMatch(html, /FAC-TEST-01|>Facture<\/dt>/)
  }
  assert.equal(state.requests.length, 3)
  assert.ok(state.requests.every(({ headers }) =>
    headers.get("x-imprimerie-invoice-scope") === encodeURIComponent(scope)))
})

test("une société inactive ou un chantier hors société bloque toute requête Print Manager", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = scope
  state.user = { ...user, role: "SUPER_ADMIN" }
  for (const record of [
    null,
    { ...worksite, active: false },
    { ...worksite, companyId: "autre-societe" },
    { ...worksite, id: "autre-chantier" },
  ]) {
    state.worksite = record
    const html = await render()
    assert.match(html, /Le chantier associé est introuvable/)
    assert.doesNotMatch(html, /DEV-TEST-01|FAC-TEST-01/)
  }
  assert.equal(state.requests.length, 0)
})

test("une autre société, un rôle salarié ou une Preview ne peuvent pas ouvrir le suivi", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = scope
  for (const rejectedUser of [
    null,
    { ...user, companyId: "autre-societe" },
    { ...user, role: "EMPLOYEE" },
  ]) {
    state.user = rejectedUser
    await assert.rejects(render, /Page introuvable/)
  }
  state.user = user
  process.env.VERCEL_ENV = "preview"
  await assert.rejects(render, /Page introuvable/)
  assert.equal(state.requests.length, 0)
  assert.equal(state.worksiteReads.length, 0)
})

test("une identité serveur absente bloque toute requête même avec le droit facture", async () => {
  process.env.IMPRIMERIE_INVOICE_READ_SCOPE = scope
  state.token = null
  const html = await render()
  assert.match(html, /Le suivi Print Manager est temporairement indisponible/)
  assert.doesNotMatch(html, /FAC-TEST-01/)
  assert.equal(state.requests.length, 0)
})
