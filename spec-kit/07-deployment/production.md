# Production

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : règles normatives du kit ; ES-001 §23–§25 prévalent.

## Pré-conditions (toutes)

- [ ] Spec, périmètre et revue indépendante validés ; CI verte (ou vérification de remplacement consignée).
- [ ] Staging validé avec preuves.
- [ ] **PRR : verdict GO ou GO avec conditions** (Autorité PRR ; complète ou allégée selon `02-governance/change-management.md`). **Sans PRR, pas de production pour un module critique** (ES-001 §25.4).
- [ ] Plan de migration, ordre de déploiement et rollback écrits (en-tête de la migration).
- [ ] Backup / point de restauration de la base de production identifié.
- [ ] **Autorisation explicite de l'utilisateur, pour cette action précise.**

## Séquence

1. Appliquer la migration **dans l'ordre de l'en-tête de cette migration** (`migrate deploy`, jamais `db push`) : migration d'abord pour V1A/V1C, code d'abord pour V1B-db.
2. Déployer le code.
3. **Smoke test** : parcours critique du module sur le tenant prévu, lecture de contrôle de la base (contraintes/triggers attendus présents), vérification de l'absence d'erreurs.
4. Conserver les **preuves** (sorties, captures, requêtes) dans la spec (`acceptance.md`).
5. Mettre à jour `05-domains/modules-status.md` : **RELEASED** avec preuve ; **CLOSED** seulement quand les conditions de la PRR sont levées et les critères ES-001 §26 satisfaits.

## En cas d'anomalie

Ne pas improviser : appliquer `rollback.md`, informer l'utilisateur, diagnostiquer, documenter.
