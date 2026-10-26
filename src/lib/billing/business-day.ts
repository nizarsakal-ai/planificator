// ═══════════════════════════════════════════════════════════════════════════
// Jour métier des pièces de facturation (correctif S3, revue Codex R2 du 26/10/2026).
// Le fuseau métier du circuit est Europe/Paris (comme la validité des devis, P2-04) : la DATE D'ÉMISSION d'une facture, d'un acompte
// ou d'un avoir et la SÉRIE ANNUELLE de son numéro (FAC-AAAA, AV-AAAA, PROV-AAAA) dérivent du jour civil de Paris à l'instant de la
// décision (relu après les verrous, `decisionClock`), jamais des composantes UTC d'un instant capturé au début de la requête.
// Exemple : 2026-12-31T23:30:00Z = 1er janvier 2027 à 00:30 à Paris ⇒ issueDate 2027-01-01, série 2027.
// Implémentation partagée (module neutre) : src/lib/time/business-day.ts.
// ═══════════════════════════════════════════════════════════════════════════
export { BUSINESS_TIMEZONE as BILLING_TIMEZONE, addBusinessDays, businessDay, businessYear } from "@/lib/time/business-day"
