# Assistant IA — IA-1 : copilote en lecture seule

## Ce que fait ce lot

Un bouton « Assistant » (ou Ctrl+J / ⌘J) sur toutes les pages du tableau de bord ouvre un panneau de discussion.
L'administrateur pose une question en français ; Claude Haiku 5.5 consulte les données de la société grâce à des
outils de **lecture** et répond avec des liens cliquables vers les fiches.

Outils (tous filtrés sur la société de la session, bornés en nombre de lignes) :

| Outil | Données |
|---|---|
| `planning_periode` | Affectations équipe → chantier sur une période (62 jours au plus) |
| `disponibilites_jour` | Équipes libres / occupées et employés absents un jour donné |
| `chercher_chantiers` | Chantiers par texte (nom, adresse, client) ou statut |
| `detail_chantier` | Fiche d'un chantier, prochaines affectations, factures liées |
| `factures` | Impayées, en retard, brouillons, payées, avec totaux TTC |
| `absences_periode` | Absences qui chevauchent une période |
| `stock_bas` | Articles sous le seuil minimal |
| `chercher_clients` | Clients, nombre de chantiers, montant impayé |
| `consultations_recentes` | Dernières consultations reçues |
| `equipes` | Équipes actives, chefs d'équipe, nombre d'employés |

## Garde-fous

- **Lecture seule** : aucun outil n'écrit, n'envoie ni ne supprime (vérifié par les tests).
- **Société** : le `companyId` vient toujours de la session, jamais du modèle.
- **Rôles** : ADMIN et SUPER_ADMIN seulement en IA-1.
- **Données non fiables** : le prompt système interdit de suivre des instructions contenues dans les données.
- **Rendu** : seuls les liens internes `[libellé](/chemin)` et le **gras** sont interprétés ; tout le reste est du texte.
- **Quota** : nombre de questions par jour et par société (compteur dans `history_logs`, entité `CopilotRequest`,
  sans question ni réponse).
- **Journal d'échec** : phase et code seulement, jamais le contenu.
- **Mémoire** : la conversation reste dans le navigateur ; rien n'est conservé côté serveur.

## Activation (désactivé par défaut)

| Variable | Valeur |
|---|---|
| `COPILOT_ENABLED` | `true` |
| `COPILOT_COMPANY_ID` | identifiant de la société pilote |
| `ANTHROPIC_API_KEY` | déjà présente |
| `COPILOT_DAILY_LIMIT` | facultatif, 1 à 500 (50 par défaut) |

Sans l'une d'elles : pas de bouton et le point d'accès `/api/assistant/copilote` répond 404.

## Tests

`npm run test:copilot`

---

# IA-2 : actions avec confirmation

L'assistant peut **préparer** trois actions ; il ne les fait jamais lui-même :

| Outil | Action après « Je confirme » | Fonction de l'interface réutilisée |
|---|---|---|
| `proposer_tache` | Crée une tâche interne | `createTask` (module Tâches) |
| `proposer_affectation` | Affecte une équipe à un chantier (1 à 62 jours) | `affecterEquipe` (notification et courriel au chef d'équipe, comme à la main) |
| `proposer_devis` | Crée un **brouillon** de devis (jamais envoyé) | `createQuoteAction` (module Devis, drapeau `BILLING_COMPLETE_ENABLED`) |

Nouveaux outils de lecture : `chercher_employes`, `chercher_articles` ; `equipes` renvoie désormais les identifiants.
Les courriels sont rédigés dans la réponse, à copier : rien n'est envoyé.

## Déroulé

1. Claude appelle un outil `proposer_*`. Le serveur vérifie les références **dans la société de la session**, refuse les
   affectations dans le passé ou en conflit, valide le devis comme le formulaire (montants, TVA, totaux).
2. Le serveur signe la proposition (HMAC dérivé de `AUTH_SECRET`, 15 minutes, liée à l'utilisateur et à la société) et
   le panneau affiche une carte avec **Je confirme** / **Annuler**.
3. `POST /api/assistant/copilote/action` vérifie le jeton, réserve son numéro dans `history_logs` (entité `CopilotAction`,
   une seule exécution) puis appelle la fonction de l'interface, qui refait tous ses contrôles. En cas d'échec, la
   réservation est libérée.

## Activation

Drapeau distinct, désactivé par défaut : `COPILOT_ACTIONS_ENABLED=true` (en plus des variables d'IA-1).
Sans lui, l'assistant reste en lecture seule et le point d'accès de confirmation répond 404.
