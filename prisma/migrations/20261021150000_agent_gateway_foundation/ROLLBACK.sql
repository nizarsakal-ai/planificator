-- PLAN-AGENT-GATEWAY-001 — LOT-1A — rollback (NON exécuté automatiquement).
-- Autorisé uniquement tant qu'aucune donnée n'existe dans les tables agent_* (SPEC §13.2 :
-- après LOT-1B, retrait de schéma seulement après export des journaux et expiration de la rétention).
-- Ordre : tables dépendantes d'abord, puis types. Aucune table existante touchée.
DROP TABLE IF EXISTS "agent_rate_windows";
DROP TABLE IF EXISTS "agent_access_logs";
DROP TABLE IF EXISTS "agent_anon_rate_windows";
DROP TABLE IF EXISTS "agent_gateway_control";
DROP TABLE IF EXISTS "agent_principals";
DROP TYPE IF EXISTS "AgentScope";
DROP TYPE IF EXISTS "AgentAccessOutcome";
DROP TYPE IF EXISTS "AgentPrincipalStatus";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261021150000_agent_gateway_foundation';
