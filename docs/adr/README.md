# ADR — Architecture Decision Records

| Champ | Valeur |
|-------|--------|
| **Statut** | Guide — aucun ADR listé ici |
| **Audience** | Contributeurs, architecture |
| **Norme** | [ENGINEERING-STANDARD-001](../constitution/ENGINEERING-STANDARD-001.md) §21 |

Ce répertoire accueille les **décisions d’architecture** de Planificator.  
**Aucun ADR fictif** ne doit être créé. Ce fichier décrit uniquement la convention.

---

## Objectif

Tracer les décisions significatives, durables ou coûteuses à inverser : contexte, options, choix, conséquences. Une décision structurante non tracée n’est pas considérée comme valide (ES-001-§21.5).

---

## Numérotation et format d’identifiant

- Format de fichier : `ADR-PLAN-NNN-titre-court.md`
- `NNN` : entier à trois chiffres, croissant (`001`, `002`, …)
- Titre dans le document : `ADR-PLAN-NNN — Titre lisible`
- Ne pas réutiliser un numéro, même pour un ADR déprécié, remplacé ou rejeté

---

## Statuts autorisés

| Statut | Signification |
|--------|---------------|
| **Proposé** | En revue, pas encore engagé |
| **Accepté** | Fait foi jusqu’à révision |
| **Déprécié** | Ne plus suivre pour les nouveaux travaux |
| **Remplacé** | Succédé par un autre ADR (référencer le successeur) |
| **Rejeté** | Décision non retenue ; conserver pour traçabilité |

---

## Immutabilité relative et supersession

- Tout ADR **Accepté** est **relativement immuable** (ES-001-§21.3).
- Un **changement matériel** produit un **nouvel ADR**.
- L’ancien est marqué **Remplacé**, avec **référence explicite au successeur**.
- Un ADR accepté **NE DOIT PAS** être réécrit silencieusement.

---

## Liens SPEC / TASK

- Toute **SPEC** issue d’un ADR **DOIT** référencer cet ADR (ES-001-§21.4).
- Tout ADR **DOIT** lister les **SPEC** ou **TASK** connues qui l’implémentent, **lorsque celles-ci existent**.

---

## Contenu minimal

Un ADR **DOIT** contenir au minimum (ES-001-§21.2) :

1. identifiant et titre ;
2. statut ;
3. contexte ;
4. décision ;
5. conséquences ;
6. alternatives considérées ;
7. références aux SPEC / TASK d’implémentation connues (ou « aucune à ce jour »).

---

## Comment créer un ADR

1. Confirmer que la décision est structurante (frontière de module, contrat, persistance, auth, multi-tenant, dette lourde, etc. — voir aussi ES-001-§11).
2. Créer `docs/adr/ADR-PLAN-NNN-….md` avec le prochain numéro libre.
3. Renseigner le contenu minimal ci-dessus.
4. Faire valider par l’**Autorité Architecture** (voir [constitution](../constitution/README.md#autorités-fonctionnelles-planificator)).
5. Mettre à jour l’index ci-dessous lorsqu’un ADR réel existe.

---

## Index

| ID | Titre | Statut |
|----|-------|--------|
| — | Aucun ADR pour l’instant | — |
