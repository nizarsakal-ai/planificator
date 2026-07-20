# Constitution Planificator

| Champ | Valeur |
|-------|--------|
| **Statut** | Normatif — documentation fondatrice du dépôt |
| **Audience** | Contributeurs, architecture, agents |
| **Portée** | Dépôt Planificator |

---

## Hiérarchie documentaire

```
ENGINEERING-STANDARD-001
↓
PLAN-GOVERNANCE-001
↓
ADR
↓
SPEC
↓
TASK
↓
Implémentation
```

| Niveau | Document | Rôle |
|--------|----------|------|
| 1 | [ENGINEERING-STANDARD-001](./ENGINEERING-STANDARD-001.md) | Norme d'ingénierie supérieure (multi-projets) |
| 2 | [PLAN-GOVERNANCE-001](./PLAN-GOVERNANCE-001.md) | Gouvernance locale Planificator (cycle modules, exigences projet) |
| 3 | [ADR](../adr/README.md) | Décisions d'architecture tracées |
| 4 | SPEC | Spécifications / blueprints de module ou de capacité |
| 5 | TASK | Découpage opérationnel |
| 6 | Implémentation | Code, migrations, tests — toujours subordonnés aux niveaux ci-dessus |

## Règles de prévalence

1. **ENGINEERING-STANDARD-001** est la **norme supérieure**. Tout contributeur et tout module sous cette gouvernance lui est subordonné.
2. Les documents locaux (PLAN-GOVERNANCE-001, ADR, SPEC, runbooks) **peuvent compléter** ES-001 pour le contexte Planificator.
3. Les documents locaux **ne doivent jamais contredire** ES-001 sur la sécurité, l'intégrité des données, la traçabilité ou le multi-tenant.
4. En cas de conflit apparent, **la règle la plus stricte** sur la sécurité, l'intégrité et la traçabilité prévaut (voir ES-001, préambule).
5. Toute **dérogation** à ES-001 ou à PLAN-GOVERNANCE-001 **doit être documentée** : écrite, datée, motivée, limitée dans le temps, et approuvée par l'autorité compétente (voir ES-001-§4.4 et Annexe C).

## Emplacements

| Type | Emplacement |
|------|-------------|
| Constitution / standards | `docs/constitution/` |
| ADR | `docs/adr/` |
| Runbooks | `docs/runbooks/` |
| Specs modules | `docs/` (ex. fondations de module) |

---

## Adoption et synchronisation d’ENGINEERING-STANDARD-001

| Champ | Valeur |
|-------|--------|
| **Standard adopté** | `ENGINEERING-STANDARD-001` |
| **Version adoptée** | `1.0.0` |
| **Date du standard** | `2026-07-20` |
| **Date d’adoption Planificator** | `2026-07-20` |
| **SHA-256** | `6180c4b038f50183debea9bed0093ed7a3687a50e4b485b3ac54cccd1ca3d23d` |
| **Copie locale** | [`docs/constitution/ENGINEERING-STANDARD-001.md`](./ENGINEERING-STANDARD-001.md) |
| **Source canonique provisoire** | `/Users/isac/AURORA/docs/constitution/ENGINEERING-STANDARD-001.md` |

### Règles normatives

1. La copie locale **NE DOIT PAS** être modifiée directement.
2. Tout amendement **DOIT** d’abord être validé dans la **source canonique**.
3. La copie Planificator **DOIT** ensuite être **remplacée intégralement** par le fichier source validé (pas de patch partiel).
4. La **version**, la **date d’adoption** et le **hash** **DOIVENT** être mis à jour **ensemble** dans la présente section.
5. Toute PR qui met à jour la copie ES-001 **DOIT** fournir une preuve `diff` ou `shasum` démontrant l’identité avec la source validée.
6. Une **divergence de hash** entre la copie locale et la source adoptée **DOIT** bloquer l’adoption ou la livraison documentaire concernée.

Le chemin absolu de la source canonique provisoire est une **référence d’exploitation locale**. Il **NE DOIT PAS** être utilisé comme lien portable dans le [README racine](../../README.md).

> **Note.** Le futur déplacement vers un dépôt neutre `engineering-standards` fera l’objet d’une décision et d’une migration documentaire séparées. Hors périmètre de l’adoption courante.

---

## Dérogations

### Règles

- Aucune dérogation ne peut être **permanente par défaut**.
- Une **date d’expiration** est **obligatoire**.
- Toute **prolongation** constitue une **nouvelle décision tracée** (nouvelle ligne ou nouvel ID, avec approbation).
- Une dérogation portant sur la **sécurité**, l’**intégrité** ou le **multi-tenant** exige l’approbation **conjointe** de l’**Autorité Architecture** et de l’**Autorité Produit**.
- Une dérogation **expirée** est **non conforme** jusqu’à clôture ou renouvellement formel.

### Registre

État initial : **Aucune dérogation enregistrée.**

| ID | Règle ES concernée | Justification | Risque accepté | Propriétaire | Date d’approbation | Date d’expiration | Statut | Approbateur |
|----|---------------------|---------------|----------------|--------------|--------------------|-------------------|--------|-------------|
| — | — | — | — | — | — | — | — | — |

---

## Autorités fonctionnelles Planificator

Rôles **fonctionnels** (sans nom de personne). Une même personne **PEUT** cumuler plusieurs rôles dans une petite équipe, mais les responsabilités **DOIVENT** rester explicites sur chaque décision.

### Autorité Produit

- Valide le besoin, le périmètre et les priorités.
- Accepte les risques métier résiduels.

### Autorité Architecture

- Valide ADR, architecture, frontières, sécurité structurelle et dérogations techniques.

### Responsable d’Implémentation

- Réalise ou pilote l’implémentation conformément aux documents validés.

### Reviewer Indépendant

- N’est pas l’auteur principal du changement.
- Réalise la revue factuelle avant merge.

### Autorité PRR

- Rend le verdict **GO**, **GO avec conditions** ou **NO-GO**.
- Ne peut pas déclarer **MODULE CLOSED** si des conditions PRR restent ouvertes.

### Autorité de Merge Exceptionnel

- Autorise exceptionnellement un merge avec un check non vert **uniquement** en incident urgent documenté.
- Exige justification, ticket de suivi, rollback et régularisation.

### Décisions minimales

| Décision | Autorité requise |
|----------|------------------|
| ADR | Autorité Architecture |
| SPEC | Autorité Produit + Autorité Architecture si structurante |
| Dérogation ES-001 | Autorité Architecture, et Autorité Produit si impact métier |
| Dérogation sécu / intégrité / multi-tenant | Autorité Architecture **et** Autorité Produit (conjoint) |
| PRR | Autorité PRR |
| Merge standard | Reviewer Indépendant + CI verte |
| Merge exceptionnel | Autorité de Merge Exceptionnel |
| MODULE CLOSED | Autorité Produit + Autorité Architecture ou Autorité PRR |
