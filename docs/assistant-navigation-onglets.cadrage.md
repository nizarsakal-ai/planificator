# Assistant IA — cadrage des onglets Discussion, Propositions et Journal

| Champ | Valeur |
|---|---|
| **Statut** | Proposé — à relire par Codex avant tout code |
| **Base** | Étape 1 (commit local `e1bdf2d`) : entrée du lot F renommée « Propositions », lien « Propositions et journal » dans le panneau |
| **Maquette** | `docs/maquettes/assistant-onglets.html` |
| **Principe** | Une seule entrée « Assistant IA ». Navigation fusionnée, **moteurs séparés** : règles locales du lot F et copilote Claude gardent leurs données, droits, confirmations et historiques |

## 1. Objectif

Remplacer les deux entrées actuelles (« Assistant IA » et « Propositions ») par un panneau unique à trois onglets,
sans fusionner les moteurs ni les tables, et sans changer qui a le droit de voir ou de décider quoi.

## 2. Onglets

| Onglet | Contenu | Source | Actions |
|---|---|---|---|
| **Discussion** | Conversation actuelle du copilote (briefing, suggestions, cartes « Je confirme ») | Copilote IA (inchangé) | Inchangées : cartes signées, confirmation unique |
| **Propositions** | Propositions **en attente** du lot F (titre, règle, sources, date) et bouton « Analyser maintenant » | `AssistantProposal` (lot F) | V1 : lien « Décider » vers `/assistant#<id>` (formulaire d'approbation existant). Pas de nouvelle action d'écriture dans le panneau |
| **Journal** | Événements récents, lecture seule, avec la **source** de chaque ligne | `AssistantActionLog` (lot F) et `history_logs` `CopilotAction` (copilote) | Aucune |

Comptes affichés dans les onglets : « Propositions (n en attente) ». La pastille du menu reste celle du briefing (IA-3).

## 3. Droits (inchangés, appliqués par onglet côté serveur)

| Profil | Discussion | Propositions | Journal |
|---|---|---|---|
| ADMIN / SUPER_ADMIN, lot F actif pour la société (`resolveAssistantAccess` ok) | oui | oui | oui : lot F + copilote |
| ADMIN / SUPER_ADMIN, lot F inactif ou autre société | oui | **masqué** | oui : copilote seulement |
| TEAM_LEADER, EMPLOYEE (si `COPILOT_ROLES` les ouvre) | oui | masqué | masqué |
| CLIENT (portail client) | oui | masqué | masqué |

- Sans onglet visible autre que Discussion : **pas de barre d'onglets** (le panneau reste identique à aujourd'hui).
- Le navigateur ne décide rien : il reçoit du serveur la liste des onglets autorisés ; chaque route de données refait la garde.

## 4. Routes

| Route | Méthode | Garde | Réponse |
|---|---|---|---|
| `/assistant` | page | `assistantPageAccess` (inchangée) | Page complète du lot F, conservée pour les liens et l'approbation |
| `/api/assistant/propositions` | GET | `resolveAssistantAccess` (même garde que `/assistant`) ; 404 si lot inactif, 401, 403 | Propositions `PENDING` de la société de session, 50 au plus, champs d'affichage seulement (pas de `payload` complet) |
| `/api/assistant/journal` | GET | Administration du copilote (`copilotConfig` + ADMIN/SUPER_ADMIN) ; partie lot F ajoutée **seulement si** `resolveAssistantAccess` ok | 50 événements les plus récents fusionnés par date : `{ source: "regles" \| "assistant-ia", date, evenement, detail }`, sans contenu de conversation ni secret |
| Analyse du lot F | action serveur existante `analyseAction` | `requireAssistantAdmin` (inchangée) | Réutilisée telle quelle depuis l'onglet |

Aucune migration. Aucune nouvelle table. Aucun changement des actions d'approbation ou de rejet.

## 5. Navigation et accessibilité

- `role="tablist"`, `role="tab"`, `aria-selected`, flèches gauche/droite, onglet actif mémorisé pendant la session du navigateur.
- Ouverture directe d'un onglet : événement d'ouverture avec onglet cible (le lien « Propositions et journal » de l'étape 1 devient « ouvrir l'onglet Propositions »).
- Mobile 375 px : trois onglets courts (Discussion · Propositions · Journal) sur une ligne ; contenu défilant sous la barre.

## 6. Critères de test

**Unitaires (sans base)**
1. Liste des onglets calculée par le serveur pour chaque ligne du tableau §3 (6 cas : admin lot actif, admin lot inactif, admin autre société, chef d'équipe, employé, client).
2. `/api/assistant/propositions` : 404 lot inactif, 401 sans session, 403 non administrateur, 200 administrateur autorisé ; champs renvoyés limités.
3. `/api/assistant/journal` : partie lot F absente si lot inactif ; partie copilote présente pour l'administrateur ; 403 pour les autres rôles.
4. Rendu : sans onglet autorisé autre que Discussion, aucune barre d'onglets ; attributs ARIA présents sinon.

**PostgreSQL jetable (deux sociétés jumelles)**
5. Propositions et journal filtrés sur la société de session ; aucune ligne de l'autre société.
6. Journal fusionné trié par date, source correcte sur chaque ligne, 50 lignes au plus.

**Navigateur (recette locale, comme l'étape 1)**
7. Administrateur, lot actif : trois onglets ; « Analyser maintenant » crée des propositions visibles dans l'onglet ; « Décider » ouvre `/assistant`.
8. Administrateur, lot inactif : Discussion et Journal seulement ; `/assistant` en 404.
9. Employé : panneau identique à aujourd'hui, pas de barre d'onglets ; `/api/assistant/journal` et `/api/assistant/propositions` refusés.
10. Mobile 375 px et clavier seul (Tab, flèches, Entrée).

**Non-régression** : `npm run test:copilot`, `test:copilot:pg`, `tests/navigation`, `tests/assistant`.

## 7. Étapes

| Étape | Contenu | Publication |
|---|---|---|
| 1 (faite, locale) | Renommage « Propositions », lien dans le panneau | Arbitrage de Nizar |
| 2 | Onglets et deux routes de lecture ci-dessus ; entrée « Propositions » du menu **conservée** | Après revue Codex et recette |
| 3 | Retrait de l'entrée « Propositions » du menu (route `/assistant` conservée) | Après usage réel de l'étape 2 |

## 8. Risques

- **Droits** : le risque principal est d'exposer l'onglet Journal à un rôle non administrateur ; d'où la liste d'onglets calculée côté serveur et la garde refaite par chaque route.
- **Mélange des historiques** : uniquement à l'affichage, avec la source sur chaque ligne ; aucune écriture croisée.
- **Journal du copilote minimal** : il ne contient que le type d'action, l'auteur et la date (aucune question ni réponse n'est conservée) ; l'onglet ne doit pas promettre davantage.
- **Libellé « Modèle d'IA externe : non autorisé »** affiché par la page du lot F (`providers.ts`) : exact pour les règles locales, trompeur à côté du copilote Claude. À reformuler (« Ce module n'utilise pas d'IA externe ») dans l'étape 2, avec une courte décision d'architecture.
- **Tests du menu** : l'étape 3 modifie les tests du lot F qui figent l'entrée de menu.
