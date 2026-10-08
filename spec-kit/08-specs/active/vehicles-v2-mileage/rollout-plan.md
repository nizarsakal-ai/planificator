# Plan de déploiement — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : plan. Suit `07-deployment/*` et le workflow du kit.

0. **Prérequis avant tout merge** : lever le doute « Vercel déploie-t-il la production automatiquement depuis `main` ? » (voir `02-governance/change-management.md`). Si oui, le code V2 partirait en production **avant** `migrate deploy` (code incompatible avec l'ancienne base, `migration-plan.md`) et avant la PRR : il faut alors désactiver ce déploiement automatique ou protéger la production pour ce lot.
1. Spec validée par l'utilisateur ; ADR (entité trajet) accepté ; décisions D1–D6 tranchées.
2. Implémentation sur branche dédiée depuis `origin/main` ; tests unitaires + pg verts ; V0–V1C non régressés.
3. **Revue indépendante** (autre instance que l'implémenteur) ; corrections.
4. PR ; merge selon la constitution (Reviewer Indépendant + CI verte) sur **instruction explicite** — jamais par un agent seul.
5. **Staging** : backup, `migrate status` / `migrate deploy` (hôte staging confirmé), déploiement du code, validation sur tenant de test, preuves.
6. **PRR complète : verdict GO** (Autorité PRR), **puis autorisation explicite de l'utilisateur** pour la production.
7. **Production** : `migrate deploy` **avant** le code V2, puis déploiement, puis smoke (créer un trajet, clôturer avec arrivée ≥ départ, tenter arrivée < départ → refusé, vérifier CHECK en base).
8. Mise à jour de `05-domains/modules-status.md` : **RELEASED** avec preuves ; **CLOSED** quand les conditions PRR sont levées et ES-001 §26 satisfait.

**Rollback** : voir `07-deployment/rollback.md` et en-tête de la migration. Feature flag non prévu : **DÉCISION REQUISE** (livrer V2 derrière un flag ?).
