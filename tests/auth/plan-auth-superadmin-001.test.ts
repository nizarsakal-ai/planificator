/**
 * PLAN-AUTH-SUPERADMIN-001 — middleware authorized + session Edge-safe.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import {
  authConfig,
  authorizedCallback,
  edgeJwtCallback,
  edgeSessionCallback,
} from "@/auth.config"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function req(pathname: string) {
  return { nextUrl: new URL(`http://localhost${pathname}`) }
}

function authUser(role: string | undefined, loggedIn = true) {
  if (!loggedIn) return null
  return {
    user: {
      id: "user-1",
      role,
      companyId: role === "SUPER_ADMIN" ? null : "company-1",
      email: "u@example.com",
      name: "User",
    },
  }
}

describe("PLAN-AUTH-SUPERADMIN-001 — authorized middleware", () => {
  it("SUPER_ADMIN autorisé sur /super-admin/entreprises", () => {
    const result = authorizedCallback({
      auth: authUser("SUPER_ADMIN"),
      request: req("/super-admin/entreprises"),
    })
    assert.equal(result, true)
  })

  it("ADMIN refusé sur /super-admin/entreprises", () => {
    const result = authorizedCallback({
      auth: authUser("ADMIN"),
      request: req("/super-admin/entreprises"),
    })
    assert.equal(result, false)
  })

  it("utilisateur non connecté refusé sur /super-admin/entreprises", () => {
    const result = authorizedCallback({
      auth: authUser(undefined, false),
      request: req("/super-admin/entreprises"),
    })
    assert.equal(result, false)
  })

  it("CLIENT refusé sur /super-admin/entreprises", () => {
    const result = authorizedCallback({
      auth: authUser("CLIENT"),
      request: req("/super-admin/entreprises"),
    })
    assert.equal(result, false)
  })

  it("dashboard normal inchangé pour ADMIN", () => {
    const result = authorizedCallback({
      auth: authUser("ADMIN"),
      request: req("/dashboard"),
    })
    assert.equal(result, true)
  })

  it("dashboard normal inchangé pour SUPER_ADMIN", () => {
    const result = authorizedCallback({
      auth: authUser("SUPER_ADMIN"),
      request: req("/dashboard"),
    })
    assert.equal(result, true)
  })

  it("sans role sur auth.user (bug Edge) → refus fail-closed /super-admin", () => {
    const result = authorizedCallback({
      auth: { user: { role: undefined } },
      request: req("/super-admin/entreprises"),
    })
    assert.equal(result, false)
  })
})

describe("PLAN-AUTH-SUPERADMIN-001 — session / JWT Edge-safe", () => {
  it("session expose id, role et companyId depuis le JWT", async () => {
    const session = await edgeSessionCallback({
      session: {
        user: { email: "sa@example.com", name: "SA", emailVerified: null },
        expires: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      token: {
        id: "sa-id",
        role: "SUPER_ADMIN",
        companyId: null,
      } as never,
    })
    assert.equal(session.user.id, "sa-id")
    assert.equal(session.user.role, "SUPER_ADMIN")
    assert.equal(session.user.companyId, null)
  })

  it("jwt Edge copie user → token sans Prisma", async () => {
    const token = await edgeJwtCallback({
      token: {} as never,
      user: {
        id: "u1",
        role: "SUPER_ADMIN",
        companyId: null,
      },
    })
    assert.equal(token.id, "u1")
    assert.equal(token.role, "SUPER_ADMIN")
    assert.equal(token.companyId, null)
  })

  it("jwt Edge préserve le rôle déjà présent (pas de strip)", async () => {
    const token = await edgeJwtCallback({
      token: {
        id: "u1",
        role: "ADMIN",
        companyId: "c1",
      } as never,
    })
    assert.equal(token.role, "ADMIN")
    assert.equal(token.companyId, "c1")
  })

  it("authConfig enregistre jwt + session + authorized (middleware)", () => {
    assert.equal(typeof authConfig.callbacks?.authorized, "function")
    assert.equal(typeof authConfig.callbacks?.jwt, "function")
    assert.equal(typeof authConfig.callbacks?.session, "function")
  })
})

describe("PLAN-AUTH-SUPERADMIN-001 — garde-fous structurels", () => {
  it("middleware n'importe pas Prisma", () => {
    const src = readFileSync(join(ROOT, "src/middleware.ts"), "utf8")
    assert.equal(src.includes("prisma"), false)
    assert.equal(src.includes("@/lib/prisma"), false)
    assert.match(src, /authConfig/)
  })

  it("auth.config n'importe pas Prisma", () => {
    const src = readFileSync(join(ROOT, "src/auth.config.ts"), "utf8")
    assert.equal(src.includes("@/lib/prisma"), false)
    assert.equal(src.includes("@prisma/client"), false)
  })

  it("auth.ts merge authConfig.callbacks (pas d'écrasement silencieux)", () => {
    const src = readFileSync(join(ROOT, "src/auth.ts"), "utf8")
    assert.match(src, /\.\.\.authConfig\.callbacks/)
    assert.match(src, /prisma\.user\.findUnique/)
  })
})
