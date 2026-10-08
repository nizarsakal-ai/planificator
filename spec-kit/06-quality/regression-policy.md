# Politique de non-régression

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : règles normatives du kit ; ancrages **VÉRIFIÉS** cités.

1. **Une correction de bug commence par un test qui échoue** (reproduction), puis le correctif. Modèle : `tests/security/plan-security-hotfix-001.test.ts` (branché sur `npm run test:security:hotfix`). Attention : `tests/chantiers/chantier-update-nullable-dates.test.ts` existe mais **n'est dans aucun script** (voir `testing-strategy.md`).
2. **Un module verrouillé ne se rouvre pas** sans spec. Vehicles V0–V1C : toute modification de leur comportement exige une spec et une revue indépendante.
3. **Compatibilité ascendante des migrations** : l'ancien code déployé doit rester valide pendant la fenêtre de déploiement (voir `04-database/migration-policy.md`).
4. **Ne pas casser les contrats** : codes d'erreur et statuts HTTP stables (`TrucksErrorCode`), noms de contraintes SQL versionnés (testés par lecture du SQL).
5. **Les tests de migration lisent le SQL** : modifier une migration appliquée est interdit (nouvelle migration).
6. **Avant merge** : lancer les scripts `test:*` des domaines touchés **et** de ceux qui en dépendent (Vehicles ↔ Teams ↔ Employees).
7. **Après incident** : ajouter le test qui aurait détecté l'incident, rattaché à l'identifiant d'exigence ou de lot.

## Zones sans filet (régression non détectable aujourd'hui)

Planning, finance, pointage, logements, absences (hors un test de formulaire). Toute modification de ces zones **commence par un audit et des tests de caractérisation**.
