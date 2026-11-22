import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { CSP_REPORT_ONLY, SECURITY_HEADERS } from "../../next.config"

const header = (key: string) => SECURITY_HEADERS.find(h => h.key === key)?.value

describe("SECURITY-HEADERS-001 : en-têtes de sécurité", () => {
  it("les en-têtes appliqués sont présents", () => {
    assert.match(header("Strict-Transport-Security") ?? "", /^max-age=\d{7,}$/)
    assert.equal(header("X-Frame-Options"), "DENY")
    assert.equal(header("X-Content-Type-Options"), "nosniff")
    assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin")
  })
  it("HSTS : ni includeSubDomains ni preload (décision d'architecture)", () => {
    assert.doesNotMatch(header("Strict-Transport-Security") ?? "", /includeSubDomains|preload/i)
  })
  it("permissions : caméra et géolocalisation gardées pour l'application, micro refusé", () => {
    const value = header("Permissions-Policy") ?? ""
    assert.match(value, /camera=\(self\)/)
    assert.match(value, /geolocation=\(self\)/)
    assert.match(value, /microphone=\(\)/)
  })
  it("CSP : report-only uniquement, jamais appliquée à ce stade", () => {
    assert.ok(header("Content-Security-Policy-Report-Only"))
    assert.equal(header("Content-Security-Policy"), undefined)
  })
  it("CSP : directives de base restrictives", () => {
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'"])
      assert.ok(CSP_REPORT_ONLY.split("; ").includes(d), d)
  })
})
