# Runbooks — exploitation Planificator

| Champ | Valeur |
|-------|--------|
| **Statut** | Guide — aucun runbook opérationnel listé ici |
| **Audience** | Ops, autorités fonctionnelles, on-call |
| **Norme** | [ENGINEERING-STANDARD-001](../constitution/ENGINEERING-STANDARD-001.md) §23–§25 |

Ce répertoire accueille les **procédures d’exploitation** versionnées.
**Aucun runbook réel** n’est fourni ici : uniquement les conventions.

Les runbooks font partie des preuves de Production Readiness (ES-001-§25) et des critères MODULE CLOSED (ES-001-§26, C10–C11).

---

## Catégories

| Catégorie | Objet |
|-----------|--------|
| **activation** | Mise en service d’une capacité / module en environnement cible |
| **rollback** | Repli contrôlé après déploiement ou changement à risque |
| **incident** | Containment, diagnostic, communication, escalade, post-mortem |
| **reprise** | Retour au service nominal après incident ou interruption |
| **maintenance** | Fenêtres planifiées, migrations, rotations, bascules contrôlées |

---

## Format d’identifiant

Format unique :

```text
RB-PLAN-NNN-titre-court.md
```

`NNN` : entier à trois chiffres, croissant. Ne pas réutiliser un numéro.

---

## Contenu obligatoire d’un runbook réel

Chaque runbook réel **DOIT** contenir :

| Champ | Description |
|-------|-------------|
| Identifiant | `RB-PLAN-NNN` |
| Titre | Libellé clair |
| Propriétaire fonctionnel | Rôle (pas seulement une personne) |
| Environnement concerné | ex. staging, production |
| Prérequis | Accès, secrets, fenêtres, dépendances |
| Procédure | Étapes numérotées |
| Critères de succès | Vérifications objectives |
| Procédure d’arrêt ou rollback | Repli sûr |
| Risques | Risques résiduels et mitigations |
| Preuves de test | Références (CI, exercices, checklists) |
| Date de création | ISO date |
| Date de dernière validation | ISO date |
| Prochaine date de revue | ISO date |
| Liens | ADR / SPEC / incident associés |

---

## Index

| ID / Fichier | Catégorie | Statut |
|--------------|-----------|--------|
| — | — | Aucun runbook pour l’instant |
