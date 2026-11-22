/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2B
 * Façade d'administration de la configuration de routage (plan LOT-2 I8 ; SPEC LOT-2 §18.3) :
 * - AuthZ : ADMIN ou SUPER_ADMIN, toujours sur la société de la SESSION (`ctx.companyId`), jamais une société reçue ;
 * - normalisation, bornes et invariant IDENTITÉ délégués à `InboundSourceWriteService` (repris de la PR #42) ; la
 *   base revérifie l'invariant et « un Binding actif par Source » ;
 * - audit de chaque mutation dans `history_logs`, sans aucune valeur brute ni normalisée.
 * Aucune UI (LOT-6), aucun Router (LOT-2C), aucune admission (LOT-3).
 */
import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import type { PipelineBinding } from "@/lib/integration/contracts/pipeline-binding"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { PipelineBindingRepository, type PipelineBindingRepositoryPort } from "@/lib/integration/persistence/pipeline-binding.repository"
import { RoutingConfigAuditRepository, type RoutingConfigAuditPort } from "@/lib/integration/persistence/routing-config-audit.repository"

export interface RoutingConfigActor { companyId: string; userId: string; role: string }

export class RoutingConfigForbiddenError extends Error {
  readonly code = "ROUTING_CONFIG_FORBIDDEN" as const
  constructor() { super("ROUTING_CONFIG_FORBIDDEN"); this.name = "RoutingConfigForbiddenError" }
}

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

export class RoutingConfigAdminService {
  constructor(
    private readonly writes: InboundSourceWriteService = new InboundSourceWriteService(),
    private readonly bindings: PipelineBindingRepositoryPort = new PipelineBindingRepository(),
    private readonly audit: RoutingConfigAuditPort = new RoutingConfigAuditRepository(),
  ) {}

  private guard(actor: RoutingConfigActor): void {
    if (!actor.companyId || !actor.userId || !ADMIN_ROLES.has(actor.role)) throw new RoutingConfigForbiddenError()
  }
  private log(actor: RoutingConfigActor, entityType: "InboundSource" | "InboundSourceRule" | "PipelineBinding", entityId: string, detail: string) {
    return this.audit.record({ companyId: actor.companyId, actorId: actor.userId, entityType, entityId, detail })
  }

  async createSource(actor: RoutingConfigActor, displayName: string): Promise<InboundSource> {
    this.guard(actor)
    const s = await this.writes.createSource({ companyId: actor.companyId, displayName })
    await this.log(actor, "InboundSource", s.id, "Source de routage créée (désactivée)")
    return s
  }

  async setSourceEnabled(actor: RoutingConfigActor, sourceId: string, enabled: boolean): Promise<InboundSource> {
    this.guard(actor)
    const s = await this.writes.setSourceEnabled(actor.companyId, sourceId, enabled)
    await this.log(actor, "InboundSource", s.id, enabled ? "Source de routage activée" : "Source de routage désactivée")
    return s
  }

  async createRule(actor: RoutingConfigActor, input: { sourceId: string; type: InboundSourceRuleType; value: string; enabled?: boolean }): Promise<InboundSourceRule> {
    this.guard(actor)
    const r = await this.writes.createRule({ companyId: actor.companyId, sourceId: input.sourceId, type: input.type, value: input.value, enabled: input.enabled })
    await this.log(actor, "InboundSourceRule", r.id, `Règle ${r.type} ajoutée${r.enabled ? "" : " (désactivée)"}`)
    return r
  }

  async setRuleEnabled(actor: RoutingConfigActor, ruleId: string, enabled: boolean): Promise<InboundSourceRule> {
    this.guard(actor)
    const r = await this.writes.setRuleEnabled(actor.companyId, ruleId, enabled)
    await this.log(actor, "InboundSourceRule", r.id, `Règle ${r.type} ${enabled ? "activée" : "désactivée"}`)
    return r
  }

  async createBinding(actor: RoutingConfigActor, input: { sourceId: string; connectionId?: string | null }): Promise<PipelineBinding> {
    this.guard(actor)
    const b = await this.bindings.create({ companyId: actor.companyId, sourceId: input.sourceId, connectionId: input.connectionId ?? null })
    await this.log(actor, "PipelineBinding", b.id, `Binding vers ${b.pipelineId} créé (désactivé)${b.connectionId ? ", limité à une Connection" : ""}`)
    return b
  }

  async setBindingEnabled(actor: RoutingConfigActor, bindingId: string, enabled: boolean): Promise<PipelineBinding> {
    this.guard(actor)
    const b = await this.bindings.setEnabled(actor.companyId, bindingId, enabled)
    await this.log(actor, "PipelineBinding", b.id, enabled ? "Binding activé" : "Binding désactivé")
    return b
  }
}
