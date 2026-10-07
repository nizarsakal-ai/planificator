# Definition of Done

> Audience : agents IA, contributeurs · Statut : Draft (ES-001 §20.4)

Renvoie à **ES-001 §6 (Definition of Done)**, **§25 (PRR)** et **§26 (MODULE CLOSED)** — normatifs, non dupliqués. Ce fichier ajoute la **checklist de preuves du kit**.

Rappel (ES-001 §6.2) : un changement est Done si comportement conforme, tests au niveau du risque, **revue de code**, pas de secret exposé, documentation à jour, **CI verte**, rollback connu. Un module « Done » en livraison doit satisfaire la PRR **avant** mise en production (§6.3). **Done d'une tâche ≠ MODULE CLOSED.**

## Pour une exigence

- [ ] Identifiant d'exigence (ex. `V2-MIL-004`) dans la spec.
- [ ] Implémentation : fichier(s) et fonction(s) cités.
- [ ] Test automatisé nommé (fichier + cas), ou justification écrite si non testable.
- [ ] Preuve : sortie de test, requête SQL ou capture, rattachée dans `acceptance.md`.

## Pour une livraison

- [ ] Spec et périmètre validés avant le code.
- [ ] Tests unitaires verts ; tests PostgreSQL (`*.pg.test.ts`) verts si le métier ou la base l'exige, sur base jetable gardée.
- [ ] **CI verte** (ES-001 §6.2.6, §9.4). **À CONFIRMER** : aucun `.github/workflows` dans le dépôt ; tant que la CI n'est pas identifiée, le reviewer indique explicitement quelle vérification la remplace (`npm run lint`, `npm run build`, scripts `test:*` du domaine) et le consigne dans la PR (ES-001 §6.4 : pas d'omission silencieuse).
- [ ] Revue indépendante rendue (autre instance que l'implémenteur), points bloquants traités.
- [ ] Migration : plan, ordre de déploiement, runbook d'échec, rollback dans l'**en-tête** (modèle : migrations Vehicles).
- [ ] Isolation tenant et RBAC vérifiés côté serveur avec un test de non-accès inter-entreprises.
- [ ] Staging validé.
- [ ] **PRR GO** (complète ou allégée, voir `change-management.md`) **puis** autorisation explicite de l'utilisateur.
- [ ] Smoke test en production avec preuves attachées.
- [ ] `05-domains/modules-status.md` mis à jour avec l'état ES-001 exact (RELEASED après déploiement prouvé ; CLOSED après PRR et critères §26).

## Ce qui ne suffit pas

« Ça compile », « les tests de l'implémenteur passent », « un agent l'a relu » (si c'est le même), un merge sans déploiement vérifié.
