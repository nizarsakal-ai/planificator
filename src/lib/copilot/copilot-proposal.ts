/**
 * IA-2 : propositions d'action du copilote. Claude ne fait JAMAIS l'action : il prépare une proposition que le serveur
 * vérifie (références de la société, conflits), puis signe (HMAC, 15 minutes, liée à l'utilisateur et à la société).
 * Le navigateur affiche une carte ; seul le clic « Je confirme » exécute l'action, une seule fois, par les mêmes
 * fonctions que l'interface (mêmes contrôles de droits et de données).
 */
import { createHmac, randomUUID, timingSafeEqual } from "crypto"

type Env = Record<string, string | undefined>

export type ProposalKind = "TASK" | "ASSIGNMENT" | "QUOTE" | "AUTOMATION"

export interface TaskPayload { title: string; description: string | null; priority: "LOW" | "MEDIUM" | "HIGH"; dueDate: string | null; assigneeId: string | null; worksiteId: string | null }
export interface AssignmentPayload { worksiteId: string; teamId: string; dateFrom: string; dateTo: string }
export interface QuoteLinePayload { articleId: string | null; designation: string; unit: string; quantity: string; unitPrice: string; vatRate: string }
/** IA-5 : règle d'automatisation, toujours créée en BROUILLON (approbation dans la page Automatisations). */
export interface AutomationPayload { name: string; trigger: string; stageFilter: string | null; action: string; taskTitle: string | null; taskAssigneeId: string | null; taskDueInDays: number | null; message: string | null }
export interface QuotePayload { worksiteId: string; issueDate: string; subject: string | null; lines: QuoteLinePayload[] }

export type ProposalPayload =
  | { kind: "TASK"; data: TaskPayload }
  | { kind: "ASSIGNMENT"; data: AssignmentPayload }
  | { kind: "QUOTE"; data: QuotePayload }
  | { kind: "AUTOMATION"; data: AutomationPayload }

/** Ce que le navigateur affiche (aucune donnée hors de la société de l'utilisateur). */
export interface ProposalCard { token: string; kind: ProposalKind; title: string; details: string[]; warning?: string }

interface Envelope { v: 1; n: string; c: string; u: string; e: number; p: ProposalPayload }

export const PROPOSAL_TTL_MS = 15 * 60_000

export function proposalSecret(env: Env = process.env): string | null {
  const base = (env.AUTH_SECRET ?? env.NEXTAUTH_SECRET)?.trim()
  if (!base || base === "undefined") return null
  // Clé dérivée : un jeton de proposition n'est valable pour aucun autre usage du secret de session.
  return createHmac("sha256", base).update("planificator:copilot-proposal:v1").digest("hex")
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url")
const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url")

export function signProposal(payload: ProposalPayload, ctx: { companyId: string; userId: string }, secret: string, now = Date.now()): string {
  const env: Envelope = { v: 1, n: randomUUID(), c: ctx.companyId, u: ctx.userId, e: now + PROPOSAL_TTL_MS, p: payload }
  const body = b64(JSON.stringify(env))
  return `${body}.${sign(body, secret)}`
}

export type VerifyResult =
  | { ok: true; nonce: string; payload: ProposalPayload }
  | { ok: false; reason: "INVALID" | "EXPIRED" | "OTHER_USER" }

export function verifyProposal(token: unknown, ctx: { companyId: string; userId: string }, secret: string, now = Date.now()): VerifyResult {
  if (typeof token !== "string" || token.length > 20_000) return { ok: false, reason: "INVALID" }
  const [body, mac, extra] = token.split(".")
  if (!body || !mac || extra !== undefined) return { ok: false, reason: "INVALID" }
  const expected = Buffer.from(sign(body, secret))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "INVALID" }
  let env: Envelope
  try { env = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Envelope } catch { return { ok: false, reason: "INVALID" } }
  if (env?.v !== 1 || typeof env.n !== "string" || !env.p) return { ok: false, reason: "INVALID" }
  if (env.c !== ctx.companyId || env.u !== ctx.userId) return { ok: false, reason: "OTHER_USER" }
  if (typeof env.e !== "number" || env.e < now) return { ok: false, reason: "EXPIRED" }
  return { ok: true, nonce: env.n, payload: env.p }
}
