/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2B
 * Repository PipelineBinding — tenanté. « Au plus un Binding actif par Source » est garanti par l'index unique
 * partiel en base ; la Connection de scope doit appartenir à la même société (clé composite).
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { PIPELINE_ID_CONSULTATIONS, pipelineBindingSchema, type PipelineBinding } from "@/lib/integration/contracts/pipeline-binding"
import {
  InboundSourceConflictError,
  InboundSourceNotFoundError,
  InboundSourcePersistenceError,
  InboundSourceValidationError,
} from "@/lib/integration/persistence/inbound-source.errors"

type Row = { id: string; companyId: string; sourceId: string; pipelineId: string; connectionId: string | null; enabled: boolean; schemaVersion: string; createdAt: Date; updatedAt: Date }

function toBinding(r: Row): PipelineBinding {
  return pipelineBindingSchema.parse({ ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() }) as PipelineBinding
}

function mapError(e: unknown): never {
  if (e instanceof InboundSourceNotFoundError || e instanceof InboundSourceValidationError || e instanceof InboundSourceConflictError) throw e
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P2002") throw new InboundSourceConflictError("Un Binding actif existe déjà pour cette Source")
    if (e.code === "P2003") throw new InboundSourceValidationError("Source ou Connection inconnue pour ce tenant")
  }
  throw new InboundSourcePersistenceError()
}

export interface PipelineBindingRepositoryPort {
  create(input: { companyId: string; sourceId: string; connectionId?: string | null }): Promise<PipelineBinding>
  setEnabled(companyId: string, id: string, enabled: boolean): Promise<PipelineBinding>
  listBySource(companyId: string, sourceId: string): Promise<PipelineBinding[]>
}

export class PipelineBindingRepository implements PipelineBindingRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async create(input: { companyId: string; sourceId: string; connectionId?: string | null }): Promise<PipelineBinding> {
    if (!input.companyId || !input.sourceId) throw new InboundSourceValidationError()
    try {
      const row = await this.db.pipelineBinding.create({
        data: { companyId: input.companyId, sourceId: input.sourceId, connectionId: input.connectionId ?? null, pipelineId: PIPELINE_ID_CONSULTATIONS, enabled: false },
      })
      return toBinding(row)
    } catch (e) { mapError(e) }
  }

  async setEnabled(companyId: string, id: string, enabled: boolean): Promise<PipelineBinding> {
    if (!companyId || !id) throw new InboundSourceNotFoundError()
    try {
      const r = await this.db.pipelineBinding.updateMany({ where: { id, companyId }, data: { enabled } })
      if (r.count !== 1) throw new InboundSourceNotFoundError()
      return toBinding(await this.db.pipelineBinding.findFirstOrThrow({ where: { id, companyId } }))
    } catch (e) { mapError(e) }
  }

  async listBySource(companyId: string, sourceId: string): Promise<PipelineBinding[]> {
    if (!companyId) throw new InboundSourceValidationError()
    const rows = await this.db.pipelineBinding.findMany({ where: { companyId, sourceId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    return rows.map(toBinding)
  }
}
