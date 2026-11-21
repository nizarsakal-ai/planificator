-- 22/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-8B : valeur LIVE du mode de connecteur (lot F).
-- Migration SÉPARÉE de son usage : PostgreSQL interdit d'utiliser une valeur d'énumération dans la transaction qui
-- l'ajoute ; contraintes et déclencheurs qui la citent sont dans la migration suivante (20261122090100).
ALTER TYPE "ConnectorMode" ADD VALUE 'LIVE';
