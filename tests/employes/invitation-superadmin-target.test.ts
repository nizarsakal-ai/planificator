/**
 * Supervision — invitation vers une entreprise désignée par son id (réservée au SUPER_ADMIN).
 *
 * Cœur réel `inviterMembreImpl` (import réel, dépendances doublées, aucune base) :
 *  - isolation : tout rôle autre que SUPER_ADMIN est refusé dès que le champ cible est présent (aucune écriture) ;
 *  - cible explicite : id bien formé obligatoire (vide / mal typé ⇒ refus, jamais de repli), entreprise existante
 *    et active, vérifiée et journalisée même si elle est l'entreprise courante du SUPER_ADMIN ;
 *  - atomicité : un seul port transactionnel (purge + création + journal) ; en cas d'échec, erreur propagée,
 *    ni e-mail, ni lien, ni revalidation ; e-mail uniquement après validation ;
 *  - ports de supervision absents ⇒ refus avant toute lecture ou écriture ;
 *  - normalisation serveur de l'adresse (espaces, casse) ; ambiguïté d'identité refusée ;
 *  - parcours sans champ cible : strictement inchangé.
 * Contrôles structurels sur l'adaptateur Prisma, le formulaire et la page super-admin.
 *
 * Exécution : npm run test:employes
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  IDENTITY_AMBIGUOUS,
  INVITE_IDENTITY_AMBIGUOUS,
  INVITE_TARGET_INVALID_MESSAGE,
  INVITE_TARGET_UNAVAILABLE_MESSAGE,
  inviterMembreImpl,
  type ExistingMember,
  type InviterMembreDeps,
} from "@/lib/actions/invitation-invite.core"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
const GALYA = "cogalya000000000000000001"
const NOISAC = "cmpzbd1m70001nd28kse0vsw8"
const INACTIVE = "coinactive00000000000001"

type Session = Awaited<ReturnType<InviterMembreDeps["requireSession"]>>
type Options = {
  existing?: ExistingMember | null | typeof IDENTITY_AMBIGUOUS
  withTargetPort?: boolean
  withTxPort?: boolean
  txFails?: boolean
}

function setup(session: Session, opts: Options = {}) {
  const log: { op: string; args: unknown }[] = []
  const companies: Record<string, { id: string; name: string; active: boolean }> = {
    [GALYA]: { id: GALYA, name: "GALYA EVENTS", active: true },
    [NOISAC]: { id: NOISAC, name: "Nohisac structure", active: true },
    [INACTIVE]: { id: INACTIVE, name: "Tenant de test", active: false },
  }
  const deps: InviterMembreDeps = {
    requireSession: async () => session,
    findExistingUser: async (email, companyId) => { log.push({ op: "findExistingUser", args: { email, companyId } }); return opts.existing ?? null },
    deletePendingInvitations: async (email, companyId) => { log.push({ op: "deletePending", args: { email, companyId } }) },
    findCompanyName: async (companyId) => { log.push({ op: "findCompanyName", args: { companyId } }); return companies[companyId]?.name ?? null },
    createInvitation: async (data) => { log.push({ op: "createInvitation", args: data }); return { id: "inv-legacy" } },
    sendEmail: async (args) => { log.push({ op: "sendEmail", args }) },
    revalidate: () => { log.push({ op: "revalidate", args: null }) },
    randomToken: () => "tok-fixed",
    now: () => new Date("2026-10-24T12:00:00.000Z"),
  }
  if (opts.withTargetPort !== false) {
    deps.findTargetCompany = async (id) => { log.push({ op: "findTargetCompany", args: { id } }); return companies[id] ?? null }
  }
  if (opts.withTxPort !== false) {
    deps.createSupervisedInvitation = async (data) => {
      log.push({ op: "tx", args: data })
      if (opts.txFails) throw new Error("rollback simulé")
      return { id: "inv-1" }
    }
  }
  return { deps, log, ops: () => log.map((l) => l.op), arg: (op: string) => log.find((l) => l.op === op)?.args as any }
}

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f }
const invite = (deps: InviterMembreDeps, target?: string, role = "ADMIN", email = "nohisacstructures@gmail.com") =>
  inviterMembreImpl(fd({ email, role, ...(target !== undefined ? { targetCompanyId: target } : {}) }), deps)

const superAdmin = (companyId: string | null): Session => ({ id: "sa-galya", role: "SUPER_ADMIN", companyId, name: "Galya", email: "contactgalyaprod@example.com" })
const admin = (companyId: string): Session => ({ id: "admin-1", role: "ADMIN", companyId, name: "Admin" })

// L'e-mail n'est envoyé que si RESEND_API_KEY est définie : on l'active pour prouver l'ordre transaction → e-mail.
let savedKey: string | undefined
beforeEach(() => { savedKey = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = "re_test_dummy" })
afterEach(() => { if (savedKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = savedKey })

describe("isolation — le champ cible est réservé au SUPER_ADMIN", () => {
  it("ADMIN de Galya ciblant Noisac ⇒ refus, aucune lecture ni écriture", async () => {
    const { deps, ops } = setup(admin(GALYA))
    assert.deepEqual(await invite(deps, NOISAC), { error: "Accès refusé" })
    assert.deepEqual(ops(), [])
  })
  it("ADMIN désignant SA PROPRE entreprise ⇒ refus (le champ n'existe que pour la supervision)", async () => {
    const { deps, ops } = setup(admin(GALYA))
    assert.deepEqual(await invite(deps, GALYA, "EMPLOYEE"), { error: "Accès refusé" })
    assert.deepEqual(ops(), [])
  })
  it("TEAM_LEADER ciblant une autre entreprise ⇒ refus, aucune écriture", async () => {
    const { deps, ops } = setup({ id: "tl", role: "TEAM_LEADER", companyId: GALYA })
    assert.deepEqual(await invite(deps, NOISAC, "EMPLOYEE"), { error: "Accès refusé" })
    assert.deepEqual(ops(), [])
  })
  it("sans champ cible, le parcours historique est strictement conservé (entreprise de session, ports historiques)", async () => {
    const { deps, arg, ops } = setup(admin(GALYA))
    const r = await invite(deps, undefined, "EMPLOYEE")
    assert.equal(r.success, true)
    assert.deepEqual(ops(), ["findExistingUser", "deletePending", "findCompanyName", "createInvitation", "sendEmail", "revalidate"])
    for (const op of ["findExistingUser", "deletePending", "findCompanyName", "createInvitation"]) assert.equal(arg(op).companyId, GALYA, op)
  })
})

describe("SUPER_ADMIN — invitation ADMIN vers l'entreprise exacte, en une transaction", () => {
  it("Galya (rattaché à GALYA EVENTS) invite un ADMIN dans Noisac par id : transaction puis e-mail puis revalidation", async () => {
    const { deps, arg, ops } = setup(superAdmin(GALYA))
    const r = await invite(deps, NOISAC)
    assert.equal(r.success, true)
    assert.match(r.invitationUrl ?? "", /\/invitation\?token=tok-fixed$/)
    assert.deepEqual(ops(), ["findTargetCompany", "findExistingUser", "tx", "sendEmail", "revalidate"], "aucun port historique (purge/création séparées) sur ce parcours")
    assert.equal(arg("findExistingUser").companyId, NOISAC)
    assert.deepEqual(arg("tx"), {
      email: "nohisacstructures@gmail.com", role: "ADMIN", companyId: NOISAC, invitedById: "sa-galya",
      token: "tok-fixed", expiresAt: new Date("2026-10-31T12:00:00.000Z"),
    })
    assert.deepEqual(arg("sendEmail"), { to: "nohisacstructures@gmail.com", token: "tok-fixed", companyName: "Nohisac structure", invitedByName: "Galya", role: "ADMIN" })
  })
  it("cible explicite égale à l'entreprise courante du SUPER_ADMIN ⇒ vérifiée et journalisée (transaction) quand même", async () => {
    const { deps, ops, arg } = setup(superAdmin(GALYA))
    const r = await invite(deps, GALYA)
    assert.equal(r.success, true)
    assert.deepEqual(ops(), ["findTargetCompany", "findExistingUser", "tx", "sendEmail", "revalidate"])
    assert.equal(arg("tx").companyId, GALYA)
  })
  it("SUPER_ADMIN sans entreprise propre (companyId null) : cible explicite acceptée", async () => {
    const { deps, arg } = setup(superAdmin(null))
    const r = await invite(deps, NOISAC)
    assert.equal(r.success, true)
    assert.equal(arg("tx").companyId, NOISAC)
  })
  it("SUPER_ADMIN sans entreprise propre et sans cible ⇒ « Entreprise introuvable », aucune écriture", async () => {
    const { deps, ops } = setup(superAdmin(null))
    await assert.rejects(() => invite(deps), /Entreprise introuvable/)
    assert.deepEqual(ops(), [])
  })
  it("échec de la transaction ⇒ erreur propagée, ni e-mail, ni revalidation, ni lien", async () => {
    const { deps, ops } = setup(superAdmin(GALYA), { txFails: true })
    await assert.rejects(() => invite(deps, NOISAC), /rollback simulé/)
    assert.deepEqual(ops(), ["findTargetCompany", "findExistingUser", "tx"])
  })
  it("sans RESEND_API_KEY : aucun appel e-mail, lien retourné après la transaction", async () => {
    delete process.env.RESEND_API_KEY
    const { deps, ops } = setup(superAdmin(GALYA))
    const r = await invite(deps, NOISAC)
    assert.equal(r.success, true)
    assert.deepEqual(ops(), ["findTargetCompany", "findExistingUser", "tx", "revalidate"])
  })
  it("identité déjà active dans la cible ⇒ refus historique, aucune transaction", async () => {
    const existing: ExistingMember = { id: "u-makram", active: true, role: "ADMIN", companyId: NOISAC, employeeProfile: { id: "e", active: true, companyId: NOISAC } }
    const { deps, ops } = setup(superAdmin(GALYA), { existing })
    assert.deepEqual(await invite(deps, NOISAC, "ADMIN", "makram@example.com"), { error: "Cet employé fait déjà partie de votre entreprise." })
    assert.ok(!ops().includes("tx"))
  })
  it("rôle non invitable (CLIENT) ⇒ refus même pour le SUPER_ADMIN", async () => {
    const { deps, ops } = setup(superAdmin(GALYA))
    const r = await invite(deps, NOISAC, "CLIENT")
    assert.ok("error" in r && r.error)
    assert.ok(!ops().includes("tx"))
  })
})

describe("normalisation et ambiguïté d'identité (côté serveur)", () => {
  it("adresse avec espaces et majuscules ⇒ invitation, recherche et e-mail en minuscules", async () => {
    const { deps, arg } = setup(superAdmin(GALYA))
    const r = await invite(deps, NOISAC, "ADMIN", "  NohisacStructures@Gmail.com ")
    assert.equal(r.success, true)
    assert.equal(arg("findExistingUser").email, "nohisacstructures@gmail.com")
    assert.equal(arg("tx").email, "nohisacstructures@gmail.com")
    assert.equal(arg("sendEmail").to, "nohisacstructures@gmail.com")
  })
  it("même normalisation sur le parcours historique", async () => {
    const { deps, arg } = setup(admin(GALYA))
    await invite(deps, undefined, "EMPLOYEE", " Someone@Example.fr ")
    assert.equal(arg("createInvitation").email, "someone@example.fr")
    assert.equal(arg("deletePending").email, "someone@example.fr")
  })
  it("plusieurs identités (ou autre casse) pour l'adresse ⇒ refus codé, aucune écriture", async () => {
    const { deps, ops } = setup(superAdmin(GALYA), { existing: IDENTITY_AMBIGUOUS })
    const r = await invite(deps, NOISAC)
    assert.equal((r as { code?: string }).code, INVITE_IDENTITY_AMBIGUOUS)
    assert.deepEqual(ops(), ["findTargetCompany", "findExistingUser"])
  })
})

describe("cible invalide — fail-closed, jamais de repli silencieux", () => {
  for (const [label, value] of [["vide", ""], ["blanche", "   "], ["avec espaces", " cmpzbd1m70001nd28kse0vsw8 "], ["trop longue", "a".repeat(65)], ["caractères interdits", "id;DROP"]] as const) {
    it(`cible ${label} ⇒ « ${INVITE_TARGET_INVALID_MESSAGE} », aucune lecture`, async () => {
      const { deps, ops } = setup(superAdmin(GALYA))
      assert.deepEqual(await invite(deps, value), { error: INVITE_TARGET_INVALID_MESSAGE })
      assert.deepEqual(ops(), [])
    })
  }
  it("cible mal typée (fichier) ⇒ refus, aucune lecture", async () => {
    const { deps, ops } = setup(superAdmin(GALYA))
    const f = fd({ email: "x@example.com", role: "ADMIN" }); f.set("targetCompanyId", new Blob(["x"]), "x.txt")
    assert.deepEqual(await inviterMembreImpl(f, deps), { error: INVITE_TARGET_INVALID_MESSAGE })
    assert.deepEqual(ops(), [])
  })
  it("entreprise inexistante ⇒ refus explicite, aucune écriture", async () => {
    const { deps, ops } = setup(superAdmin(GALYA))
    assert.deepEqual(await invite(deps, "coinconnue0000000000000001"), { error: INVITE_TARGET_UNAVAILABLE_MESSAGE })
    assert.deepEqual(ops(), ["findTargetCompany"])
  })
  it("entreprise désactivée ⇒ refus explicite, aucune écriture", async () => {
    const { deps, ops } = setup(superAdmin(GALYA))
    assert.deepEqual(await invite(deps, INACTIVE), { error: INVITE_TARGET_UNAVAILABLE_MESSAGE })
    assert.deepEqual(ops(), ["findTargetCompany"])
  })
  it("adaptateur sans port de cible ou sans port transactionnel ⇒ refus avant toute lecture", async () => {
    for (const opts of [{ withTargetPort: false }, { withTxPort: false }]) {
      const { deps, ops } = setup(superAdmin(GALYA), opts)
      assert.deepEqual(await invite(deps, NOISAC), { error: "Accès refusé" })
      assert.deepEqual(ops(), [])
    }
  })
})

describe("contrôles structurels — adaptateur, formulaire, page", () => {
  const actions = readFileSync(join(ROOT, "src/lib/actions/invitation.actions.ts"), "utf8")
  const form = readFileSync(join(ROOT, "src/components/super-admin/InviteAdminForm.tsx"), "utf8")
  const page = readFileSync(join(ROOT, "src/app/(dashboard)/super-admin/entreprises/page.tsx"), "utf8")

  it("l'adaptateur vérifie la cible en base (id + active)", () => {
    assert.match(actions, /findTargetCompany:\s*\(companyId\)\s*=>\s*prisma\.company\.findUnique\(\{\s*where:\s*\{\s*id:\s*companyId\s*\},\s*select:\s*\{\s*id:\s*true,\s*name:\s*true,\s*active:\s*true\s*\}/)
  })
  it("purge + création + journal INVITED dans UNE transaction Prisma, jeton jamais journalisé", () => {
    const block = actions.slice(actions.indexOf("createSupervisedInvitation:"), actions.indexOf("findExistingUser:"))
    assert.match(block, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*tx\.invitation\.deleteMany\([\s\S]*status:\s*"PENDING"[\s\S]*tx\.invitation\.create\([\s\S]*tx\.historyLog\.create\([\s\S]*action:\s*"INVITED"[\s\S]*entityType:\s*"Invitation"/)
    assert.ok(!/detail:[^\n]*token/.test(block))
  })
  it("recherche d'identité insensible à la casse, déterministe (findMany, ambiguïté explicite)", () => {
    const block = actions.slice(actions.indexOf("findExistingUser:"), actions.indexOf("deletePendingInvitations:"))
    assert.match(block, /prisma\.user\.findMany\(\{\s*where:\s*\{\s*email:\s*\{\s*equals:\s*email,\s*mode:\s*"insensitive"\s*\}/)
    assert.match(block, /accounts\.length > 1\) return IDENTITY_AMBIGUOUS/)
    assert.match(block, /account\.email !== email\) return IDENTITY_AMBIGUOUS/)
    assert.ok(!/findFirst/.test(block))
  })
  it("requireAdmin n'exige l'entreprise de session que pour les rôles non SUPER_ADMIN", () => {
    assert.match(actions, /if \(!session\.user\.companyId && session\.user\.role !== "SUPER_ADMIN"\) throw new Error\("Entreprise introuvable"\)/)
  })
  it("le formulaire envoie role=ADMIN et targetCompanyId, sans champ mot de passe", () => {
    assert.match(form, /fd\.set\("role",\s*"ADMIN"\)/)
    assert.match(form, /fd\.set\("targetCompanyId",\s*companyId\)/)
    assert.ok(!/password/i.test(form))
  })
  it("la page super-admin n'affiche le formulaire que pour une entreprise active, avec son id", () => {
    assert.match(page, /\{company\.active && \([\s\S]*<InviteAdminForm companyId=\{company\.id\} companyName=\{company\.name\} \/>/)
  })
})
