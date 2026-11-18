// Correctif #418 (18/11/2026) : le logo géré n'est plus transmis en data URL dans la charge RSC de la coquille.
// Une chaîne de cette taille faisait différer par le serveur Flight (seuil 3 200 caractères) la colonne de la coquille,
// rejouée ensuite pendant l'hydratation sans restauration du curseur (React #418). On vérifie l'EFFET : la valeur
// transmise à la coquille est une adresse courte (sous le seuil des morceaux texte Flight, 1 024), et la route qui la sert
// renvoie le même PNG, pour la seule société de session.
import { before, describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import sharp from "sharp"

let session: unknown = null
let queried: unknown[] = []
let storedLogo: string | null = null
type Mod = typeof import("../../src/lib/company-logo")
let logo: Mod
let GET: (r: Request) => Promise<Response>
const req = (q = "") => new Request(`https://app.example.test/api/company/logo/affichage${q}`)
type ReglePwa = { urlPattern: RegExp | ((p: { url: URL; sameOrigin: boolean; request: Request }) => boolean) }
let reglesPwa: readonly ReglePwa[]

async function pngDataUrl(width: number, height: number, noise: boolean): Promise<string> {
  const png = noise
    ? await sharp(randomBytes(width * height * 4), { raw: { width, height, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer()
    : await sharp({ create: { width, height, channels: 4, background: { r: 15, g: 52, b: 96, alpha: 1 } } }).png().toBuffer()
  return `data:image/png;base64,${png.toString("base64")}`
}

before(async () => {
  mock.module("@/auth", { namedExports: { auth: async () => session } })
  mock.module("@/lib/prisma", { namedExports: { prisma: { company: { findUnique: async (args: unknown) => { queried.push(args); return storedLogo === undefined ? null : { logoUrl: storedLogo } } } } } })
  logo = await import("../../src/lib/company-logo")
  GET = (await import("../../src/app/api/company/logo/affichage/route")).GET
  reglesPwa = (await import("../../next.config")).PWA_STATIC_RUNTIME_CACHING
})

describe("adresse d'affichage du logo dans la coquille", () => {
  it("aucun logo géré : null, comme logoForPdf (rien n'est affiché)", async () => {
    for (const v of [null, undefined, "", "https://exemple.test/logo.png", "data:image/png;base64,AAAA", "data:image/jpeg;base64,/9j/"]) {
      assert.equal(logo.companyLogoDisplaySrc(v), null, String(v))
      assert.equal(logo.logoForPdf(v), null, String(v))
    }
  })
  it("logo géré volumineux (~600 Ko) : adresse courte versionnée, jamais la data URL", async () => {
    const dataUrl = await pngDataUrl(390, 390, true)
    assert.ok(dataUrl.length > 500_000, `fixture ${dataUrl.length}`)
    const src = logo.companyLogoDisplaySrc(dataUrl)!
    assert.match(src, /^\/api\/company\/logo\/affichage\?v=[0-9a-f]{16}$/)
    assert.ok(src.length < 1024, "sous le seuil des morceaux texte Flight")
    assert.ok(!src.includes("data:"))
    assert.equal(logo.companyLogoDisplaySrc(dataUrl), src, "stable pour un même logo")
    assert.notEqual(logo.companyLogoDisplaySrc(await pngDataUrl(64, 64, false)), src, "change avec le logo")
    assert.equal(logo.logoForPdf(dataUrl), dataUrl, "les PDF gardent la data URL")
  })
})

describe("route d'affichage /api/company/logo/affichage", () => {
  it("refuse sans session, pour un CLIENT ou sans société, sans lire la base ; réponses no-store", async () => {
    queried = []
    for (const [s, code] of [[null, 401], [{ user: { id: "u", role: "CLIENT", companyId: "c1" } }, 403], [{ user: { id: "u", role: "EMPLOYEE", companyId: null } }, 403]] as const) {
      session = s
      const r = await GET(req("?v=0123456789abcdef"))
      assert.equal(r.status, code); assert.match(r.headers.get("cache-control")!, /no-store/)
    }
    assert.equal(queried.length, 0)
  })
  it("version absente, répétée ou mal formée : 404 sans lire la base", async () => {
    session = { user: { id: "u", role: "ADMIN", companyId: "A" } }
    queried = []
    for (const q of ["", "?v=", "?v=XYZ", "?v=0123456789abcdef&v=0123456789abcdef", "?v=0123456789ABCDEF", "?v=0123456789abcdef0"]) {
      const r = await GET(req(q)); assert.equal(r.status, 404, q); assert.equal((await r.arrayBuffer()).byteLength, 0)
    }
    assert.equal(queried.length, 0)
  })
  it("deux sociétés, deux versions : seul le logo de la société de session, sous SA version ; jamais sous une version étrangère", async () => {
    const logoA = await pngDataUrl(80, 40, false), logoB = await pngDataUrl(40, 80, false)
    const srcA = logo.companyLogoDisplaySrc(logoA)!, srcB = logo.companyLogoDisplaySrc(logoB)!
    assert.notEqual(srcA, srcB)
    const v = (src: string) => src.slice(src.indexOf("?"))
    // Session sur A
    session = { user: { id: "u", role: "EMPLOYEE", companyId: "A" } }; storedLogo = logoA; queried = []
    const okA = await GET(req(v(srcA)))
    assert.equal(okA.status, 200)
    assert.equal(okA.headers.get("content-type"), "image/png")
    assert.equal(okA.headers.get("content-disposition"), "inline")
    assert.equal(okA.headers.get("x-content-type-options"), "nosniff")
    assert.equal(okA.headers.get("cache-control"), "private, no-store")
    assert.deepEqual(Buffer.from(await okA.arrayBuffer()), logo.logoDataUrlToPng(logoA))
    assert.deepEqual(queried, [{ where: { id: "A" }, select: { logoUrl: true } }])
    // La session passe à B (autre onglet, changement de société) : l'adresse calculée pour A ne renvoie AUCUN PNG
    session = { user: { id: "u", role: "EMPLOYEE", companyId: "B" } }; storedLogo = logoB; queried = []
    const croise = await GET(req(v(srcA)))
    assert.equal(croise.status, 404); assert.equal(croise.headers.get("cache-control"), "private, no-store")
    assert.equal((await croise.arrayBuffer()).byteLength, 0, "aucun logo B sous l'empreinte A")
    assert.deepEqual(queried, [{ where: { id: "B" }, select: { logoUrl: true } }], "seule la société de session est lue")
    const okB = await GET(req(v(srcB)))
    assert.equal(okB.status, 200); assert.deepEqual(Buffer.from(await okB.arrayBuffer()), logo.logoDataUrlToPng(logoB))
    // Logo de A remplacé : l'ancienne version n'est plus servie
    session = { user: { id: "u", role: "EMPLOYEE", companyId: "A" } }; storedLogo = logoB
    assert.equal((await GET(req(v(srcA)))).status, 404)
  })
  it("404 sans logo géré (URL externe, aucune valeur)", async () => {
    session = { user: { id: "u", role: "ADMIN", companyId: "A" } }
    for (const stored of ["https://exemple.test/logo.png", null]) {
      storedLogo = stored
      assert.equal((await GET(req("?v=0123456789abcdef"))).status, 404)
    }
  })
  it("service worker : la route logo ne correspond à aucune règle de PWA_STATIC_RUNTIME_CACHING (jamais interceptée)", () => {
    const u = (p: string) => new URL(`https://app.example.test${p}`)
    // Même évaluation que Workbox : expression régulière sur l'adresse complète, fonction sur { url, sameOrigin, request }.
    const intercepte = (url: URL) => reglesPwa.filter((r) => r.urlPattern instanceof RegExp
      ? r.urlPattern.test(url.href)
      : r.urlPattern({ url, sameOrigin: true, request: new Request(url) }))
    assert.ok(reglesPwa.length > 0)
    assert.ok(intercepte(u("/_next/static/chunks/app-0123456789abcdef.js")).length > 0, "témoin : un fichier statique versionné est bien couvert")
    for (const p of ["/api/company/logo/affichage", "/api/company/logo/affichage?v=0123456789abcdef", "/api/company/logo"])
      assert.deepEqual(intercepte(u(p)), [], p)
  })
})
