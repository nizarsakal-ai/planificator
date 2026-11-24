/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-2B
 * Façade d'administration de la configuration de routage (plan LOT-2 I8 ; SPEC LOT-2 §18.3) :
 * - AuthZ : ADMIN ou SUPER_ADMIN, toujours sur la société de la SESSION (`ctx.companyId`), jamais une société reçue ;
 * - normalisation, bornes et invariant IDENTITÉ délégués à `InboundSourceWriteService` (repris de la PR #42) ; la
 *   base revérifie l'invariant et « un Binding actif par Source » ;
 * - audit de chaque mutation dans `history_logs`, sans aucune valeur brute ni normalisée, écrit dans la MÊME
 *   transaction que la mutation (revue indépendante du 24/11/2026, point 5).
 * Aucune UI (LOT-6), aucun Router (LOT-2C), aucune admission (LOT-3).
 */
import type { InboundSource } from "@/lib/integration/contracts/inbound-source"
import type { InboundSourceRule } from "@/lib/integration/contracts/inbound-source-rule"
import type { PipelineBinding } from "@/lib/integration/contracts/pipeline-binding"
import type { InboundSourceRuleType } from "@/lib/integration/types/inbound-source-rule-type"
import { InboundSourceWriteService } from "@/lib/integration/sources/inbound-source-write.service"
import { InboundSourceRepository } from "@/lib/integration/persistence/inbound-source.repository"
import { InboundSourceRuleRepository } from "@/lib/integration/persistence/inbound-source-rule.repository"
import { InboundSourceIdentityTx } from "@/lib/integration/persistence/inbound-source-identity.tx"
import { PipelineBindingRepository, type PipelineBindingRepositoryPort } from "@/lib/integration/persistence/pipeline-binding.repository"
import { RoutingConfigAuditRepository, type RoutingConfigAuditPort } from "@/lib/integration/persistence/routing-config-audit.repository"
import { runRoutingConfigTransaction, type RoutingConfigDb } from "@/lib/integration/persistence/routing-config.tx"

export interface RoutingConfigActor { companyId: string; userId: string; role: string }

export class RoutingConfigForbiddenError extends Error {
  readonly code = "ROUTING_CONFIG_FORBIDDEN" as const
  constructor() { super("ROUTING_CONFIG_FORBIDDEN"); this.name = "RoutingConfigForbiddenError" }
}

export interface RoutingConfigScope {
  writes: InboundSourceWriteService
  bindings: PipelineBindingRepositoryPort
  audit: RoutingConfigAuditPort
}
/** Exécute une mutation et son audit dans une même unité (transaction en production). */
export type RoutingConfigScopeRunner = <T>(fn: (scope: RoutingConfigScope) => Promise<T>) => Promise<T>

/** Portée transactionnelle : dépôts construits sur le client de transaction, mutation + audit atomiques. */
export function transactionalRoutingConfigScope(db?: RoutingConfigDb): RoutingConfigScopeRunner {
  return (fn) =>
    runRoutingConfigTransaction(
      (tx) =>
        fn({
          writes: new InboundSourceWriteService(new InboundSourceRepository(tx), new InboundSourceRuleRepository(tx), new InboundSourceIdentityTx(tx)),
          bindings: new PipelineBindingRepository(tx),
          audit: new RoutingConfigAuditRepository(tx),
        }),
      db
    )
}

const ADMIN_ROLES = new Set(["ADMIN", "SUPER_ADMIN"])

export class RoutingConfigAdminService {
  private readonly scope: RoutingConfigScopeRunner

  /**
   * Sans argument : transactionnel sur la base par défaut. Avec des dépendances explicites (tests unitaires) :
   * exécution directe, sans transaction. `scope` permet d'imposer une portée (ex. `transactionalRoutingConfigScope(db)`).
   */
  constructor(
    writes?: InboundSourceWriteService,
    bindings?: PipelineBindingRepositoryPort,
    audit?: RoutingConfigAuditPort,
    scope?: RoutingConfigScopeRunner,
  ) {
    this.scope =
      scope ??
      (writes || bindings || audit
        ? (fn) => fn({ writes: writes ?? new InboundSourceWriteService(), bindings: bindings ?? new PipelineBindingRepository(), audit: audit ?? new RoutingConfigAuditRepository() })
        : transactionalRoutingConfigScope())
  }

  static transactional(db?: RoutingConfigDb): RoutingConfigAdminService {
    return new RoutingConfigAdminService(undefined, undefined, undefined, transactionalRoutingConfigScope(db))
  }

  private guard(actor: RoutingConfigActor): void {
    if (!actor.companyId || !actor.userId || !ADMIN_ROLES.has(actor.role)) throw new RoutingConfigForbiddenError()
  }
  private log(audit: RoutingConfigAuditPort, actor: RoutingConfigActor, entityType: "InboundSource" | "InboundSourceRule" | "PipelineBinding", entityId: string, detail: string) {
    return audit.record({ companyId: actor.companyId, actorId: actor.userId, entityType, entityId, detail })
  }

  async createSource(actor: RoutingConfigActor, displayName: string): Promise<InboundSource> {
    this.guard(actor)
    return this.scope(async ({ writes, audit }) => {
      const s = await writes.createSource({ companyId: actor.companyId, displayName })
      await this.log(audit, actor, "InboundSource", s.id, "Source de routage créée (désactivée)")
      return s
    })
  }

  async setSourceEnabled(actor: RoutingConfigActor, sourceId: string, enabled: boolean): Promise<InboundSource> {
    this.guard(actor)
    return this.scope(async ({ writes, audit }) => {
      const s = await writes.setSourceEnabled(actor.companyId, sourceId, enabled)
      await this.log(audit, actor, "InboundSource", s.id, enabled ? "Source de routage activée" : "Source de routage désactivée")
      return s
    })
  }

  async createRule(actor: RoutingConfigActor, input: { sourceId: string; type: InboundSourceRuleType; value: string; enabled?: boolean }): Promise<InboundSourceRule> {
    this.guard(actor)
    return this.scope(async ({ writes, audit }) => {
      const r = await writes.createRule({ companyId: actor.companyId, sourceId: input.sourceId, type: input.type, value: input.value, enabled: input.enabled })
      await this.log(audit, actor, "InboundSourceRule", r.id, `Règle ${r.type} ajoutée${r.enabled ? "" : " (désactivée)"}`)
      return r
    })
  }

  async setRuleEnabled(actor: RoutingConfigActor, ruleId: string, enabled: boolean): Promise<InboundSourceRule> {
    this.guard(actor)
    return this.scope(async ({ writes, audit }) => {
      const r = await writes.setRuleEnabled(actor.companyId, ruleId, enabled)
      await this.log(audit, actor, "InboundSourceRule", r.id, `Règle ${r.type} ${enabled ? "activée" : "désactivée"}`)
      return r
    })
  }

  async createBinding(actor: RoutingConfigActor, input: { sourceId: string; connectionId?: string | null }): Promise<PipelineBinding> {
    this.guard(actor)
    return this.scope(async ({ bindings, audit }) => {
      const b = await bindings.create({ companyId: actor.companyId, sourceId: input.sourceId, connectionId: input.connectionId ?? null })
      await this.log(audit, actor, "PipelineBinding", b.id, `Binding vers ${b.pipelineId} créé (désactivé)${b.connectionId ? ", limité à une Connection" : ""}`)
      return b
    })
  }

  async setBindingEnabled(actor: RoutingConfigActor, bindingId: string, enabled: boolean): Promise<PipelineBinding> {
    this.guard(actor)
    return this.scope(async ({ bindings, audit }) => {
      const b = await bindings.setEnabled(actor.companyId, bindingId, enabled)
      await this.log(audit, actor, "PipelineBinding", b.id, enabled ? "Binding activé" : "Binding désactivé")
      return b
    })
  }
}
