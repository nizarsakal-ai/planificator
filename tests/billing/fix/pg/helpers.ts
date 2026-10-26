// Outils partagés des tests PostgreSQL des correctifs Lot C (revue Codex 26/10/2026). Base JETABLE migrée obligatoire.
// - seedCompanies : sociétés A/B, administrateurs, clients, chantiers (données synthétiques).
// - holdTransaction : transaction interactive tenue ouverte sur une connexion INDÉPENDANTE (deuxième PrismaClient), avec
//   barrières explicites (commit / rollback) pour les scénarios de concurrence à deux sessions.
// - appClient : client connecté avec le RÔLE APPLICATIF non propriétaire (DATABASE_URL_APP, créé par le lanceur de base jetable).
import { PrismaClient, type Prisma } from "@prisma/client"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")

export const A = { companyId: "coA", userId: "admA" }
export const B = { companyId: "coB", userId: "admB" }
export const NOW = new Date("2026-03-10T10:00:00Z")
export const D = (s: string) => new Date(`${s}T00:00:00Z`)
export const js = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))

export async function seedCompanies(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,email,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A','a@societe-a.test',now()),('coB','Société B','b','98765432100011','2 rue B','b@societe-b.test',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test','10 rue du Client',now()),('clB','coB','Client B','client-b@example.test','11 rue du Client',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wB','coB','clB','admB','Maison B',now())`)
}

export async function sqlError(db: PrismaClient | Prisma.TransactionClient, sql: string): Promise<string> {
  try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) }
}

/** Transaction tenue ouverte sur `client` : `tx` utilisable, `commit()` / `rollback()` comme barrières ; `done` = fin effective. */
export async function holdTransaction(client: PrismaClient, opts: { timeout?: number } = {}): Promise<{ tx: Prisma.TransactionClient; commit: () => Promise<void>; rollback: () => Promise<void>; done: Promise<"committed" | "rolled_back"> }> {
  let release!: (v: "commit" | "rollback") => void
  const gate = new Promise<"commit" | "rollback">((r) => { release = r })
  let ready!: (tx: Prisma.TransactionClient) => void
  const txReady = new Promise<Prisma.TransactionClient>((r) => { ready = r })
  const done: Promise<"committed" | "rolled_back"> = client.$transaction(async (tx) => {
    ready(tx)
    const v = await gate
    if (v === "rollback") throw new Error("ROLLBACK_REQUESTED")
    return "committed" as const
  }, { timeout: opts.timeout ?? 30_000, maxWait: 10_000 }).catch((e) => { if (e instanceof Error && e.message === "ROLLBACK_REQUESTED") return "rolled_back" as const; throw e })
  const tx = await txReady
  return { tx, commit: async () => { release("commit"); await done }, rollback: async () => { release("rollback"); await done }, done }
}

/** Client PostgreSQL avec le rôle applicatif NON propriétaire (droits DML seulement, déclencheurs non désactivables). */
export function appClient(): PrismaClient {
  const url = process.env.DATABASE_URL_APP
  if (!url) throw new Error("DATABASE_URL_APP requis (rôle applicatif de test créé par le lanceur de base jetable)")
  return new PrismaClient({ datasourceUrl: url })
}

export async function currentRole(db: PrismaClient): Promise<string> {
  const r = await db.$queryRaw<{ u: string }[]>`SELECT current_user::text AS u`
  return r[0].u
}

/** Attend qu'une condition devienne vraie (barrière d'observation, bornée), pour vérifier qu'une session est bien bloquée ou libérée. */
export async function waitFor(cond: () => Promise<boolean>, ms = 5000, step = 25): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}

/** Nombre de sessions PostgreSQL en attente de verrou sur cette base (preuve qu'une requête concurrente est bloquée). */
export async function waitingSessions(db: PrismaClient): Promise<number> {
  const r = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
  return Number(r[0].n)
}
