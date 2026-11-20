-- Document Studio, espace PDF (lot 4, 20/11/2026) : type de révision REDACTED (pages biffées). Migration EXPAND,
-- additive : une valeur d'énumération ajoutée, rien d'autre. Séparée de la contrainte qui l'utilise
-- (20261120160100) : PostgreSQL interdit d'employer une valeur d'énumération dans la transaction qui l'ajoute.

BEGIN;

ALTER TYPE "StudioPdfRevisionKind" ADD VALUE IF NOT EXISTS 'REDACTED';

COMMIT;
