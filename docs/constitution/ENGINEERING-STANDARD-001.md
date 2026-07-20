# ENGINEERING-STANDARD-001
## Constitution d'Ingénierie

| Champ | Valeur |
|-------|--------|
| **Identifiant** | ENGINEERING-STANDARD-001 |
| **Titre court** | Constitution d'Ingénierie |
| **Statut** | Normatif — Référence unique multi-projets |
| **Version** | 1.0.0 |
| **Date** | 2026-07-20 |
| **Portée** | AURORA, PrintManager Pro, Planificator, et tout futur projet sous cette gouvernance |
| **Nature** | Document fondateur d'ingénierie — indépendant de toute technologie métier |
| **Langue normative** | DOIT / NE DOIT PAS / RECOMMANDÉ |

---

## Préambule

Le présent document définit les **standards d'ingénierie communs** applicables à tous les projets relevant de cette gouvernance.

Il est **volontairement agnostique** : il ne prescrit aucun framework, langage, ORM, broker ou fournisseur cloud. Les spécifications techniques projet (SPEC, ADR, blueprints) déclinent ces règles dans leur contexte.

### Hiérarchie documentaire

1. **ENGINEERING-STANDARD-001** (le présent document) — standards d'ingénierie transverses
2. Constitution / documents fondateurs **spécifiques à un projet** (ex. Constitution AURORA)
3. **ADR** acceptés
4. **SPEC** et blueprints
5. Tâches, implémentations, scripts opérationnels

En cas de conflit entre un standard générique et une règle projet, le **standard le plus strict sur la sécurité, l'intégrité des données et la traçabilité** prévaut, sauf dérogation écrite et versionnée.

### Convention de référence

Toute règle est référencable de façon stable :

```
ES-001-§<section>.<règle>
```

Exemple : `ES-001-§14.3` désigne la règle 3 de la section 14 (Standards Sécurité).

Les amendements **NE DOIVENT PAS** renuméroter les règles existantes. Une règle obsolète **DOIT** être marquée *Supersédée* et conserver son identifiant.

### Niveaux d'obligation

| Mot | Signification |
|-----|---------------|
| **DOIT** | Obligation. Non-conformité = blocage de livraison ou de clôture. |
| **NE DOIT PAS** | Interdiction. Violation = non-conformité. |
| **RECOMMANDÉ** | Bonne pratique attendue. Dérogation possible si justifiée et tracée. |
| **PEUT** | Option autorisée, sans obligation. |

---

## 1. Vision

### ES-001-§1.1 — Finalité

L'ingénierie **DOIT** produire des systèmes **fiables, évolutifs, sécurisés et compréhensibles**, capables de durer au-delà des personnes et des stacks du moment.

### ES-001-§1.2 — Référence unique

Le présent document **DOIT** être traité comme la référence d'ingénierie commune. Tout projet sous cette gouvernance **DOIT** s'y conformer ou documenter une dérogation explicite.

### ES-001-§1.3 — Indépendance technologique

Les standards **NE DOIVENT PAS** dépendre d'un framework, d'un cloud ou d'un produit commercial. Les choix technologiques **DOIVENT** être consignés dans des ADR projet, pas dans ce document.

### ES-001-§1.4 — Objectifs durables

L'ingénierie **DOIT** viser :

- la **cohérence** des concepts et des contrats ;
- la **prévisibilité** des livraisons ;
- la **réversibilité** des changements risqués ;
- la **traçabilité** des décisions et des incidents ;
- la **sobriété** : pas de complexité sans besoin démontré.

---

## 2. Valeurs d'ingénierie

### ES-001-§2.1 — Cohérence

Un concept **DOIT** avoir une définition unique dans un périmètre donné. La duplication de sens **NE DOIT PAS** être tolérée sans justification.

### ES-001-§2.2 — Clarté

Tout choix structurant **DOIT** être explicite, justifié et accessible. La complexité opaque **NE DOIT PAS** être acceptée comme état normal.

### ES-001-§2.3 — Durabilité

Les raccourcis qui compromettent la sécurité, l'intégrité des données ou l'évolutivité **NE DOIVENT PAS** être pris sous pression de calendrier.

### ES-001-§2.4 — Sécurité par défaut

La sécurité **DOIT** être une propriété de conception. Elle **NE DOIT PAS** être reportée à une phase ultérieure.

### ES-001-§2.5 — Sobriété

Il **EST RECOMMANDÉ** de préférer la solution la plus simple qui satisfait réellement le besoin. L'abstraction spéculative **NE DOIT PAS** être introduite « au cas où ».

### ES-001-§2.6 — Responsabilité

Chaque décision significative **DOIT** avoir un décideur identifié et des conséquences assumées.

### ES-001-§2.7 — Preuve avant affirmation

Une affirmation de qualité, de performance ou de sécurité **DOIT** être vérifiable (tests, mesures, revue, preuve opérationnelle).

---

## 3. Principes d'architecture

### ES-001-§3.1 — Séparation des responsabilités

Les responsabilités (métier, application, infrastructure, présentation, opérations) **DOIVENT** être séparées. Une couche **NE DOIT PAS** absorber les responsabilités d'une autre sans justification architecturale.

### ES-001-§3.2 — Dépendances orientées

Les dépendances **DOIVENT** pointer des détails vers le cœur métier (ou vers les contrats stables), jamais l'inverse. Le domaine **NE DOIT PAS** dépendre de détails de transport, de persistance ou d'UI.

### ES-001-§3.3 — Contrats explicites

Les frontières entre modules, services ou bounded contexts **DOIVENT** passer par des contrats explicites (API, événements, ports). L'accès aux détails internes d'un autre module **NE DOIT PAS** être autorisé.

### ES-001-§3.4 — Modularité

Chaque module **DOIT** pouvoir évoluer avec un impact maîtrisé sur les autres. Un module **NE DOIT PAS** redéfinir les concepts socle déjà établis dans sa plateforme.

### ES-001-§3.5 — Cohérence transactionnelle locale

La cohérence forte **DOIT** être limitée à une frontière d'agrégat / intention métier claire. La cohérence distribuée **DOIT** être explicite (événements, sagas, compensation) et documentée.

### ES-001-§3.6 — Fail safe

En cas d'échec, le système **DOIT** préférer un état sûr (refus, rollback, dégradation contrôlée) à un état partiel silencieux.

### ES-001-§3.7 — Observabilité dès la conception

Les points de contrôle (logs, métriques, traces, audit) **DOIVENT** être prévus avec les fonctionnalités, pas ajoutés après incident.

### ES-001-§3.8 — Décisions tracées

Toute décision d'architecture significative **DOIT** faire l'objet d'un ADR (voir §21).

---

## 4. Gouvernance des développements

### ES-001-§4.1 — Ordre constitutionnel

Toute évolution structurante **DOIT** suivre :

```
Décision (ADR si besoin) → Spécification → Découpage → Développement → Revue → Validation → Déploiement
```

Le développement applicatif structurant **NE DOIT PAS** précéder la décision et la spécification qui le portent.

### ES-001-§4.2 — Périmètre d'un changement

Chaque lot de travail **DOIT** avoir un objectif, un périmètre, des hors-périmètre et des critères d'acceptation explicites.

### ES-001-§4.3 — Autorité

Les arbitrages structurants **DOIVENT** remonter au niveau de responsabilité approprié (Lead technique, Architecture Board, CTO selon le projet). Une décision non tracée **NE DOIT PAS** faire foi.

### ES-001-§4.4 — Dérogations

Toute dérogation à ce standard **DOIT** être écrite, datée, motivée, limitée dans le temps et approuvée par l'autorité compétente.

### ES-001-§4.5 — Dette technique

La dette introduite sciemment **DOIT** être enregistrée (ticket, registre ou ADR) avec plan de remboursement. La dette silencieuse **NE DOIT PAS** être acceptée.

---

## 5. Cycle de vie d'un module

### ES-001-§5.1 — États

Un module **DOIT** progresser selon des états explicites, au minimum :

| État | Signification |
|------|---------------|
| **PROPOSED** | Besoin identifié, pas encore engagé |
| **SPECIFIED** | Spec / blueprint validés |
| **IN_BUILD** | Implémentation en cours |
| **IN_REVIEW** | Revues qualité / architecture en cours |
| **RELEASED** | Disponible en environnement cible |
| **CLOSED** | Critères MODULE CLOSED satisfaits (§26) |
| **DEPRECATED** | Maintenance minimale, sortie planifiée |
| **RETIRED** | Retiré, plus de support actif |

### ES-001-§5.2 — Entrée en build

Un module **NE DOIT PAS** entrer en `IN_BUILD` sans spécification validée couvrant : responsabilités, modèles de données, contrats, risques, stratégie de tests.

### ES-001-§5.3 — Sortie

Un module **NE DOIT PAS** être déclaré `CLOSED` tant que les critères §26 ne sont pas tous satisfaits.

### ES-001-§5.4 — Dépréciation

La dépréciation **DOIT** être annoncée, documentée, avec date cible et trajectoire de migration pour les consommateurs.

---

## 6. Definition of Done

### ES-001-§6.1 — Done = livrable utilisable

Un travail **NE DOIT PAS** être marqué terminé s'il n'est pas intégrable, vérifiable et documenté au niveau de risque correspondant.

### ES-001-§6.2 — Checklist minimale

Pour qu'un changement soit **Done**, il **DOIT** satisfaire :

1. comportement conforme à la spécification / critères d'acceptation ;
2. tests au niveau exigé par le risque (§18) ;
3. revue de code effectuée (§10) ;
4. pas de secret, credential ou donnée personnelle exposée ;
5. documentation impactée mise à jour ;
6. CI verte sur la branche concernée ;
7. stratégie de rollback connue si le changement est déployable (§24).

### ES-001-§6.3 — Done pour un module

Un module **Done** au sens livraison **DOIT** en plus satisfaire les critères de Production Readiness applicables (§25) avant mise en production.

### ES-001-§6.4 — Exceptions

Tout item de DoD non applicable **DOIT** être explicitement justifié dans la PR ou le ticket. L'omission silencieuse **NE DOIT PAS** être acceptée.

---

## 7. Standards Git

### ES-001-§7.1 — Intégrité de l'historique

L'historique Git **DOIT** rester compréhensible. Les commits **DOIVENT** représenter des unités cohérentes de changement.

### ES-001-§7.2 — Messages de commit

Un message de commit **DOIT** expliquer le *pourquoi* (intention), pas seulement lister des fichiers. Il **EST RECOMMANDÉ** d'utiliser un style conventionnel stable au sein du dépôt (`type: résumé` ou équivalent projet).

### ES-001-§7.3 — Secrets

Les secrets, clés API, certificats privés et fichiers d'environnement contenant des credentials **NE DOIVENT PAS** être commités. En cas d'incident, la rotation **DOIT** être immédiate.

### ES-001-§7.4 — Fichiers générés et binaires

Il **EST RECOMMANDÉ** de ne versionner que les sources nécessaires à la reconstruction. Les artefacts lourds **NE DOIVENT PAS** polluer le dépôt sans nécessité.

### ES-001-§7.5 — Hooks et CI

Les garde-fous locaux (hooks) **PEUVENT** assister le contributeur. La vérité **DOIT** rester la CI distante. Contourner les hooks (`--no-verify`) **NE DOIT PAS** être pratiqué hors urgence justifiée.

### ES-001-§7.6 — Amendements et réécriture

La réécriture d'historique publié (force push sur branches partagées) **NE DOIT PAS** être effectuée sans accord explicite et sans nécessité opérationnelle.

---

## 8. Standards de branches

### ES-001-§8.1 — Branche principale protégée

La branche principale (`main` / `master` selon le dépôt) **DOIT** être protégée. Aucun push direct **NE DOIT** y être autorisé hors procédure d'urgence documentée.

### ES-001-§8.2 — Branches de travail

Tout changement **DOIT** être développé sur une branche dédiée, nommée de façon stable. Il **EST RECOMMANDÉ** d'utiliser un préfixe significatif :

| Préfixe | Usage |
|---------|--------|
| `feat/` | Nouvelle capacité |
| `fix/` | Correction |
| `chore/` | Maintenance, outillage |
| `docs/` | Documentation seule |
| `refactor/` | Refactor sans changement de comportement |
| `hotfix/` | Correctif urgent production |

### ES-001-§8.3 — Durée de vie

Les branches **DOIVENT** rester courtes. Une branche longue **DOIT** être régulièrement rebasée ou mergée depuis la base, selon la politique du dépôt.

### ES-001-§8.4 — Une intention par branche

Une branche **DOIT** porter une intention claire. Le mélange de sujets non liés **NE DOIT PAS** être accepté dans une même PR.

### ES-001-§8.5 — Environnements

Les branches d'environnement (staging, release) **PEUVENT** exister si le projet les requiert. Leur cycle de vie **DOIT** être documenté.

---

## 9. Standards Pull Requests

### ES-001-§9.1 — Obligation de PR

Tout changement intégré à la branche principale **DOIT** passer par une Pull Request (ou Merge Request) revue.

### ES-001-§9.2 — Contenu minimal

Une PR **DOIT** contenir :

- un titre précis ;
- un résumé du *pourquoi* ;
- le périmètre et les hors-périmètre ;
- le plan de test / preuves ;
- les risques et le plan de rollback si déploiement.

### ES-001-§9.3 — Taille

Il **EST RECOMMANDÉ** de garder les PR petites et focalisées. Une PR trop large **DOIT** être découpée sauf urgence justifiée.

### ES-001-§9.4 — CI obligatoire

Une PR **NE DOIT PAS** être fusionnée si la CI requise est rouge, sauf procédure d'urgence avec approbation explicite et ticket de suivi.

### ES-001-§9.5 — Approbations

Le nombre d'approbations **DOIT** être défini par dépôt. Au minimum, **une** revue indépendante de l'auteur **DOIT** être obtenue pour les changements de code.

### ES-001-§9.6 — Documentation dans la PR

Si le changement impacte un contrat, un schéma, une procédure ou un comportement utilisateur, la documentation **DOIT** être mise à jour dans la même PR ou une PR liée explicitement référencée.

---

## 10. Standards Code Review

### ES-001-§10.1 — Objectif

La revue de code **DOIT** vérifier : exactitude, lisibilité, sécurité, conformité aux standards, testabilité et impact opérationnel.

### ES-001-§10.2 — Responsabilité du reviewer

Le reviewer **DOIT** signaler les défauts bloquants. Il **NE DOIT PAS** approuver par défaut. L'approbation engage la responsabilité de conformité raisonnable.

### ES-001-§10.3 — Critères bloquants

Sont **bloquants** notamment :

- faille de sécurité ou fuite de secret ;
- rupture d'isolation multi-tenant ;
- perte de données ou transaction incorrecte ;
- absence de tests sur un chemin critique ;
- non-conformité à une règle **DOIT** de ce standard sans dérogation.

### ES-001-§10.4 — Critères non bloquants

Les suggestions de style mineures **PEUVENT** être non bloquantes. Il **EST RECOMMANDÉ** de les traiter via linters/formatters plutôt que par débat humain.

### ES-001-§10.5 — Ton

La revue **DOIT** rester factuelle et respectueuse. Les désaccords structurants **DOIVENT** être escaladés, pas enfouis.

### ES-001-§10.6 — Auto-merge

L'auto-merge **PEUT** être utilisé uniquement si les garde-fous CI et d'approbation sont satisfaits.

---

## 11. Standards Architecture Review

### ES-001-§11.1 — Déclencheurs

Une Architecture Review **DOIT** être déclenchée lorsque le changement :

- crée ou modifie une frontière de module ;
- change un contrat public (API, événement, schéma partagé) ;
- introduit un nouveau système de persistance, de messaging ou d'auth ;
- impacte multi-tenant, transactions, sécurité ou données personnelles ;
- engage une dette structurelle significative.

### ES-001-§11.2 — Entrées requises

La revue **DOIT** disposer au minimum de : contexte, options considérées, décision proposée, impacts, risques, plan de rollback, et ADR si applicable.

### ES-001-§11.3 — Sorties

La revue **DOIT** produire une décision explicite : **GO**, **GO avec conditions**, ou **NO-GO**, avec responsables et échéances.

### ES-001-§11.4 — Traçabilité

Le résultat **DOIT** être consigné (registre Architecture Board, ADR, ou compte-rendu versionné selon le projet).

### ES-001-§11.5 — Contournement

Contourner une Architecture Review requise **NE DOIT PAS** être autorisé hors urgence production, et **DOIT** alors être régularisé a posteriori sous 5 jours ouvrés.

---

## 12. Standards Base de données

### ES-001-§12.1 — Migrations versionnées

Tout changement de schéma **DOIT** être versionné, reproductible et applicable de façon ordonnée. Les modifications manuelles non tracées en production **NE DOIVENT PAS** être la norme.

### ES-001-§12.2 — Compatibilité

Les migrations **DOIVENT** privilégier la compatibilité ascendante (expand/contract). Une migration destructive **DOIT** être explicitement approuvée et accompagnée d'un plan de sauvegarde / restauration.

### ES-001-§12.3 — Intégrité

Les contraintes d'intégrité (unicité, clés étrangères, checks métier critiques) **DOIVENT** être appliquées au plus près des données lorsque le moteur le permet. S'y fier uniquement à l'application **NE DOIT PAS** être le seul garde-fou pour les invariants critiques.

### ES-001-§12.4 — Données sensibles

Les données personnelles et secrets **DOIVENT** être minimisés, protégés au repos selon le risque, et exclus des dumps non maîtrisés.

### ES-001-§12.5 — Seed et fixtures

Les seeds **DOIVENT** être déterministes et non destructifs hors environnements dédiés. Un seed **NE DOIT PAS** écraser silencieusement des données de production.

### ES-001-§12.6 — Performance schéma

Les index **DOIVENT** être justifiés par des accès réels ou prévus. Il **EST RECOMMANDÉ** de mesurer avant d'ajouter des index spéculatifs.

### ES-001-§12.7 — Ownership

Chaque table / collection **DOIT** avoir un module propriétaire clair. L'écriture transversale non maîtrisée **NE DOIT PAS** être autorisée.

---

## 13. Standards API

### ES-001-§13.1 — Contrat d'abord

Toute API publique **DOIT** avoir un contrat documenté (schéma, OpenAPI, proto, ou équivalent). L'implémentation **NE DOIT PAS** diverger silencieusement du contrat.

### ES-001-§13.2 — Versionnement

Les API publiques **DOIVENT** être versionnées. Une rupture de contrat **DOIT** produire une nouvelle version majeure (ou équivalent projet), jamais une modification silencieuse.

### ES-001-§13.3 — Idempotence

Les opérations de création / mutation exposées à des clients incertains **DOIVENT** prévoir une stratégie d'idempotence lorsque le risque de double soumission est matériel.

### ES-001-§13.4 — Erreurs

Les erreurs **DOIVENT** être stables, machine-lisibles et sans fuite d'information sensible. Les messages utilisateur **NE DOIVENT PAS** exposer stack traces ou détails internes.

### ES-001-§13.5 — AuthN / AuthZ

Toute route non publique **DOIT** authentifier et autoriser côté serveur. L'autorisation client-only **NE DOIT PAS** être considérée comme suffisante.

### ES-001-§13.6 — Pagination et limites

Les listes **DOIVENT** être bornées (pagination, curseur, ou limite explicite). Les endpoints non bornés **NE DOIVENT PAS** être exposés en production.

### ES-001-§13.7 — Compatibilité clients

Il **EST RECOMMANDÉ** de maintenir une fenêtre de compatibilité documentée pour les versions dépréciées.

---

## 14. Standards Sécurité

### ES-001-§14.1 — Moindre privilège

Les accès humains et machine **DOIVENT** être limités au strict nécessaire. Les comptes à privilèges élevés **DOIVENT** être rares, audités et protégés.

### ES-001-§14.2 — Validation serveur

Toutes les entrées externes **DOIVENT** être validées côté serveur. La validation UI **NE DOIT PAS** remplacer la validation serveur.

### ES-001-§14.3 — Protection des secrets

Les secrets **DOIVENT** vivre dans un gestionnaire de secrets / variables d'environnement contrôlées. Ils **NE DOIVENT PAS** apparaître dans le code, les logs, les tickets ou les captures d'écran.

### ES-001-§14.4 — Données personnelles

Le traitement des données personnelles **DOIT** respecter le principe de minimisation et les obligations légales applicables (notamment RGPD lorsque pertinent).

### ES-001-§14.5 — Journal d'audit

Les actions sensibles (auth, droits, accès données, mutations critiques) **DOIVENT** être auditées de façon traçable et non falsifiable raisonnablement.

### ES-001-§14.6 — Dépendances

Les dépendances **DOIVENT** être suivies pour les vulnérabilités connues. Une CVE critique sur un chemin exposé **DOIT** être traitée en priorité.

### ES-001-§14.7 — Surface d'attaque

Il **EST RECOMMANDÉ** de désactiver les interfaces de debug, admin non protégées et endpoints expérimentaux hors environnements dédiés.

### ES-001-§14.8 — Réponse incident

Tout incident de sécurité **DOIT** être traité en priorité, avec containment, correction, communication adaptée et post-mortem.

---

## 15. Standards Transactions

### ES-001-§15.1 — Intention métier atomique

Une intention métier qui doit réussir ou échouer ensemble **DOIT** s'exécuter dans une frontière transactionnelle unique (Unit of Work ou équivalent).

### ES-001-§15.2 — Pas d'état partiel

Une commande **NE DOIT PAS** laisser un état métier partiellement persisté en cas d'échec. Le rollback **DOIT** restaurer la cohérence locale.

### ES-001-§15.3 — Événements et commit

Les faits métier destinés à d'autres modules **DOIVENT** être alignés sur le commit de l'état (outbox, commit hook transactionnel, ou mécanisme équivalent garantissant l'absence de double vérité).

### ES-001-§15.4 — Durée et taille

Les transactions **DOIVENT** rester courtes. Les traitements longs **NE DOIVENT PAS** être tenus dans une transaction ouverte sans nécessité.

### ES-001-§15.5 — Concurrence

Les conflits concurrentiels prévisibles **DOIVENT** être gérés explicitement (verrous optimistes, pessimistes, ou règles métier de retry). L'écrasement silencieux **NE DOIT PAS** être acceptable sur des agrégats critiques.

### ES-001-§15.6 — Frontières

Une transaction **NE DOIT PAS** enjamber plusieurs bounded contexts sauf mécanisme explicitement conçu et documenté.

---

## 16. Standards Multi-tenant

### ES-001-§16.1 — Isolation structurelle

Lorsque le produit est multi-tenant, l'isolation des données par tenant **DOIT** être une garantie structurelle, pas un filtre optionnel oubliable.

### ES-001-§16.2 — Portée obligatoire

Toute requête de lecture / écriture sur des données tenant-scopées **DOIT** porter le contexte tenant. L'accès cross-tenant **NE DOIT PAS** être possible hors rôles et procédures explicitement autorisés (ex. super-admin audité).

### ES-001-§16.3 — Tests d'isolation

Des tests prouvant l'absence de fuite cross-tenant **DOIVENT** exister pour les chemins critiques.

### ES-001-§16.4 — Identifiants

Les identifiants globaux **NE DOIVENT PAS** permettre de déduire ou d'accéder à des ressources d'un autre tenant sans contrôle d'autorisation.

### ES-001-§16.5 — Jobs et workers

Les traitements asynchrones **DOIVENT** propager et respecter le contexte tenant. Un job **NE DOIT PAS** traiter des données hors scope.

### ES-001-§16.6 — Observabilité tenant

Il **EST RECOMMANDÉ** d'inclure un identifiant de tenant dans les corrélations de logs/traces, sans y exposer de données personnelles inutiles.

---

## 17. Standards Feature Flags

### ES-001-§17.1 — Usage légitime

Les feature flags **DOIVENT** servir à contrôler l'activation progressive, l'expérimentation contrôlée ou le kill-switch. Ils **NE DOIVENT PAS** remplacer une conception inachevée durablement.

### ES-001-§17.2 — Propriété et durée de vie

Chaque flag **DOIT** avoir un propriétaire, une date de revue et un plan de retrait. Les flags morts **DOIVENT** être nettoyés.

### ES-001-§17.3 — Sécurité

Un flag **NE DOIT PAS** contourner AuthZ, isolation tenant ou contrôles de sécurité. Désactiver une UI **NE DOIT PAS** être considéré comme une protection.

### ES-001-§17.4 — Défaut sûr

Le comportement par défaut d'un flag **DOIT** être sûr (fail closed) lorsque le risque le justifie.

### ES-001-§17.5 — Observabilité

L'état des flags critiques **DOIT** être observable (config, audit, ou métrique) pour diagnostiquer les incidents.

### ES-001-§17.6 — Documentation

Les flags structurants **DOIVENT** être documentés (nom, portée, défaut, propriétaires, conditions de retrait).

---

## 18. Standards Tests

### ES-001-§18.1 — Pyramide

La stratégie de tests **DOIT** privilégier des tests unitaires/rapides nombreux, des tests d'intégration ciblés, et peu de tests bout-en-bout coûteux mais critiques.

### ES-001-§18.2 — Obligation selon le risque

| Risque | Exigence minimale |
|--------|-------------------|
| Critique (argent, droits, données, tenant) | Tests automatisés obligatoires sur les chemins nominaux et d'échec |
| Élevé | Tests automatisés sur le comportement principal |
| Moyen | Au moins un niveau de vérification automatisée ou manuelle tracée |
| Faible | Vérification raisonnable ; automatisation RECOMMANDÉE |

### ES-001-§18.3 — Déterminisme

Les tests **DOIVENT** être déterministes. Les flaky tests **DOIVENT** être traités comme des défauts.

### ES-001-§18.4 — Données de test

Les données de test **NE DOIVENT PAS** contenir de vraies données personnelles de production.

### ES-001-§18.5 — Non-régression

Tout correctif de bug **DOIT** s'accompagner d'un test reproduisant le défaut, sauf impossibilité justifiée.

### ES-001-§18.6 — CI

Les tests requis **DOIVENT** s'exécuter en CI sur chaque PR concernée. Un test désactivé **DOIT** être justifié et suivi.

### ES-001-§18.7 — Couverture

La couverture **PEUT** être un indicateur. Elle **NE DOIT PAS** être l'unique critère de qualité. La pertinence des assertions prime.

---

## 19. Standards Observabilité

### ES-001-§19.1 — Trois piliers

Un système en production **DOIT** disposer, au niveau adapté à sa criticité, de : **logs**, **métriques** et **traces** (ou corrélation équivalente).

### ES-001-§19.2 — Corrélation

Chaque requête / job **DOIT** pouvoir être suivi via un identifiant de corrélation propagé.

### ES-001-§19.3 — Logs utiles

Les logs **DOIVENT** être structurés autant que possible, actionnables, et sans secrets. Le volume de logs de debug **NE DOIT PAS** saturer la production en permanence.

### ES-001-§19.4 — Alertes

Les alertes **DOIVENT** signaler des symptômes actionnables. Les alertes bruyantes non actionnables **DOIVENT** être corrigées.

### ES-001-§19.5 — SLI / SLO

Il **EST RECOMMANDÉ** de définir des indicateurs de service (disponibilité, latence, taux d'erreur) pour les parcours critiques.

### ES-001-§19.6 — Audit vs logs

L'audit de sécurité/métier **NE DOIT PAS** être confondu avec les logs techniques. Les deux **PEUVENT** coexister avec des rétentions distinctes.

---

## 20. Standards Documentation

### ES-001-§20.1 — Livrable de premier rang

La documentation **DOIT** être traitée comme un livrable, pas comme une option postérieure.

### ES-001-§20.2 — Documentation vivante

Tout changement structurant **DOIT** mettre à jour la documentation impactée dans le même mouvement (même PR ou PR liée).

### ES-001-§20.3 — Emplacements

Chaque dépôt **DOIT** définir clairement où vivent : constitution/standards, ADR, specs, runbooks, architecture.

### ES-001-§20.4 — Audience

Chaque document **DOIT** indiquer son audience (contributeurs, ops, architecture, métier) et son statut (draft, normatif, obsolète).

### ES-001-§20.5 — Exactitude

Une documentation fausse **DOIT** être corrigée ou marquée obsolète. Documenter un comportement inexistant **NE DOIT PAS** être acceptable.

### ES-001-§20.6 — Langue

Il **EST RECOMMANDÉ** d'utiliser une langue unique par dépôt pour les documents normatifs, afin d'éviter les divergences de traduction.

---

## 21. Standards ADR

### ES-001-§21.1 — Quand rédiger un ADR

Un ADR **DOIT** être rédigé pour toute décision d'architecture significative, durable, ou coûteuse à inverser.

### ES-001-§21.2 — Contenu minimal

Un ADR **DOIT** contenir au minimum :

1. identifiant et titre ;
2. statut (Proposé / Accepté / Déprécié / Remplacé) ;
3. contexte ;
4. décision ;
5. conséquences ;
6. alternatives considérées.

### ES-001-§21.3 — Immutabilité relative

Un ADR accepté **NE DOIT PAS** être réécrit silencieusement. Une révision matérielle **DOIT** produire un nouvel ADR ou une version explicite, et mettre à jour le statut de l'ancien.

### ES-001-§21.4 — Lien aux specs

Les specs d'implémentation **DOIVENT** référencer les ADR dont elles découlent.

### ES-001-§21.5 — Décision non tracée

Une décision structurante non tracée **NE DOIT PAS** être considérée comme valide.

---

## 22. Standards Performance

### ES-001-§22.1 — Exigences explicites

Les parcours critiques **DOIVENT** avoir des attentes de performance définies (latence, débit, volume) lorsque le risque métier le justifie.

### ES-001-§22.2 — Mesure avant optimisation

L'optimisation **DOIT** s'appuyer sur des mesures. L'optimisation prématurée sans preuve **NE DOIT PAS** primer sur la clarté.

### ES-001-§22.3 — Budgets

Il **EST RECOMMANDÉ** de définir des budgets (temps de réponse p95, taille de payload, coût requête DB) pour les endpoints critiques.

### ES-001-§22.4 — Régressions

Une régression de performance matérielle sur un parcours critique **DOIT** être traitée comme un défaut, avec seuil défini par le projet.

### ES-001-§22.5 — Charge

Avant une mise en production à fort trafic attendu, des tests de charge adaptés **DOIVENT** être envisagés et, si le risque est élevé, exécutés.

### ES-001-§22.6 — Ressources

Les fuites de connexions, mémoire ou fichiers **DOIVENT** être prévenues par conception (pools, timeouts, fermeture explicite).

---

## 23. Standards Déploiement

### ES-001-§23.1 — Reproductibilité

Un déploiement **DOIT** être reproductible à partir d'artefacts versionnés et d'une procédure documentée.

### ES-001-§23.2 — Environnements

Les environnements (dev, test, staging, prod) **DOIVENT** être clairement séparés. Les données et secrets de production **NE DOIVENT PAS** contaminer les environnements inférieurs sans contrôle.

### ES-001-§23.3 — Changements atomiques logiques

Un déploiement **DOIT** regrouper des changements compatibles. Les migrations et le code **DOIVENT** être ordonnés pour éviter les fenêtres cassées (expand → deploy → contract).

### ES-001-§23.4 — Fenêtres et communication

Les déploiements à risque **DOIVENT** être annoncés aux parties prenantes concernées, avec fenêtre et responsable.

### ES-001-§23.5 — Vérification post-déploiement

Après déploiement, une vérification minimale (**smoke check**) **DOIT** confirmer la santé des parcours critiques.

### ES-001-§23.6 — Automatisation

Il **EST RECOMMANDÉ** d'automatiser les déploiements via pipeline. Les déploiements manuels de production **DOIVENT** rester exceptionnels et journalisés.

---

## 24. Standards Rollback

### ES-001-§24.1 — Plan obligatoire

Tout changement déployable à risque **DOIT** disposer d'un plan de rollback connu avant déploiement.

### ES-001-§24.2 — Types de rollback

Le plan **DOIT** préciser la stratégie adaptée :

- revert d'artefact applicatif ;
- feature flag kill-switch ;
- reverse migration (si sûre) ;
- restauration de sauvegarde (dernier recours).

### ES-001-§24.3 — Migrations

Une migration non réversible facilement **DOIT** être signalée comme telle, avec mitigation (backup, dual-write, feature freeze).

### ES-001-§24.4 — Décision de rollback

Les critères de déclenchement (taux d'erreur, latence, corruption, incident sécurité) **DOIVENT** être définis à l'avance pour les changements critiques.

### ES-001-§24.5 — Post-rollback

Après rollback, un compte-rendu **DOIT** être produit : cause, impact, correctif, prévention.

### ES-001-§24.6 — Interdiction

Déployer sans capacité de repli sur un chemin critique **NE DOIT PAS** être autorisé hors acceptation de risque écrite.

---

## 25. Standards Production Readiness Review

### ES-001-§25.1 — Obligation

Avant la première mise en production d'un module ou d'une capacité critique, une **Production Readiness Review (PRR)** **DOIT** être réalisée.

### ES-001-§25.2 — Checklist PRR

La PRR **DOIT** vérifier au minimum :

1. contrats API / événements documentés et versionnés ;
2. AuthN / AuthZ et isolation tenant validées ;
3. transactions et chemins de données critiques testés ;
4. observabilité (logs, métriques, alertes) en place ;
5. runbooks d'incident / rollback disponibles ;
6. sauvegardes et restauration vérifiées au niveau requis ;
7. secrets et configuration gérés hors code ;
8. feature flags critiques documentés ;
9. charge / perf évaluées si risque élevé ;
10. propriétaires on-call / escalation identifiés.

### ES-001-§25.3 — Décision

La PRR **DOIT** conclure par **GO**, **GO avec conditions**, ou **NO-GO**. Les conditions **DOIVENT** avoir un propriétaire et une échéance.

### ES-001-§25.4 — Exceptions

Une mise en production sans PRR **NE DOIT PAS** être autorisée pour un module critique. Pour un changement mineur, une PRR allégée **PEUT** suffire si définie par le projet.

### ES-001-§25.5 — Preuves

Les preuves (rapports de tests, captures de dashboards, checklists signées) **DOIVENT** être conservées avec le dossier de release.

---

## 26. Critères MODULE CLOSED

### ES-001-§26.1 — Définition

Un module est **MODULE CLOSED** lorsqu'il est considéré **achevé pour sa version cible**, stable, opérable et conforme aux standards — pas seulement « code mergé ».

### ES-001-§26.2 — Critères obligatoires

Pour déclarer **MODULE CLOSED**, le module **DOIT** satisfaire **tous** les points suivants :

| # | Critère |
|---|---------|
| C1 | Spécification / blueprint à jour et alignés avec l'implémentation |
| C2 | Contrats publics documentés et versionnés |
| C3 | Definition of Done respectée sur le périmètre clos |
| C4 | Tests automatisés des chemins critiques verts en CI |
| C5 | Revues code et architecture requises complétées |
| C6 | Isolation multi-tenant prouvée si applicable |
| C7 | Transactions / intégrité des intentions métier critiques vérifiées |
| C8 | Sécurité de base validée (AuthZ, secrets, surfaces exposées) |
| C9 | Observabilité minimale opérationnelle |
| C10 | Documentation d'exploitation (runbook) disponible |
| C11 | Plan de rollback connu pour la dernière release |
| C12 | PRR **GO** (ou GO avec conditions toutes levées) |
| C13 | Aucune dette bloquante ouverte sans plan daté |
| C14 | État du module mis à jour à `CLOSED` dans le registre projet |

### ES-001-§26.3 — Non-fermeture

La présence de travaux futurs **PEUT** exister (backlog). En revanche, des défauts bloquants, une doc mensongère, une CI rouge sur le cœur du module, ou une PRR non obtenue **NE DOIVENT PAS** permettre la clôture.

### ES-001-§26.4 — Réouverture

Si un défaut structurel apparaît après clôture, le module **DOIT** être requalifié (`RELEASED` / `IN_BUILD` selon gravité) jusqu'à nouvelle clôture conforme.

### ES-001-§26.5 — Annonce

La clôture **DOIT** être annoncée dans le canal de gouvernance du projet (changelog, board, registre) avec la version concernée.

---

## Annexe A — Matrice rapide DOIT / RECOMMANDÉ

| Domaine | DOIT (extrait) | RECOMMANDÉ |
|---------|----------------|------------|
| Git / PR | PR + CI verte + pas de secrets | PR petites, messages conventionnels |
| Architecture | Contrats explicites, ADR structurants | Simplicité, YAGNI |
| Données | Migrations versionnées, intégrité | Expand/contract, index mesurés |
| API | Contrat, version, AuthZ serveur | Fenêtre de compatibilité |
| Sécurité | Moindre privilège, validation serveur | Réduction surface, revue deps |
| Transactions | Atomicité d'intention, pas d'état partiel | Transactions courtes |
| Multi-tenant | Isolation structurelle + tests | Corrélation tenant dans les logs |
| Feature flags | Pas de contournement sécu, propriétaire | Nettoyage rapide |
| Tests | Selon risque, déterministes | Couverture comme indicateur |
| Ops | Smoke post-deploy, plan rollback | Déploiements automatisés, SLO |

---

## Annexe B — Amendements

### ES-001-§B.1

Tout amendement **DOIT** :

1. conserver les identifiants de règles existants ;
2. incrémenter la version du document (semver) ;
3. indiquer date, auteur/autorité, résumé du changement ;
4. marquer *Supersédée* toute règle remplacée, sans la supprimer.

### ES-001-§B.2

Les amendements mineurs (clarifications sans changement d'obligation) **PEUVENT** être des patch versions (`1.0.x`). Les changements d'obligation **DOIVENT** être au minimum mineurs (`1.x.0`) ou majeurs si rupture de gouvernance.

---

## Annexe C — Adoption par dépôt

Chaque dépôt adoptant ce standard **DOIT** :

1. référencer `ENGINEERING-STANDARD-001` dans sa documentation fondatrice ;
2. lister ses éventuelles dérogations datées ;
3. définir les autorités locales (qui approuve ADR, PRR, dérogations) ;
4. ne pas affaiblir les règles de sécurité, d'intégrité et de multi-tenant.

---

*ENGINEERING-STANDARD-001 est la Constitution d'Ingénierie commune. Elle ne prescrit aucune stack. Elle prescrit la discipline. Tout projet, module ou contributeur sous cette gouvernance lui est subordonné.*
