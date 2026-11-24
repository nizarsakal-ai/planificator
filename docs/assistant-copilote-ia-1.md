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

---

# IA-3 : briefing du jour et veille

À l'ouverture du panneau (conversation vide), un **briefing du jour** s'affiche, calculé sur le serveur **sans IA**
(aucun coût, hors quota, aucune écriture) : chantiers et équipes du jour, équipes libres, absents, puis les alertes :

| Urgence | Alerte |
|---|---|
| Urgent | Factures en retard (nombre, total TTC) |
| Urgent | Affectations refusées dans les 7 jours (à replanifier) |
| Urgent | Chantiers qui démarrent sous 7 jours sans aucune équipe |
| À surveiller | Affectations non confirmées pour aujourd'hui ou demain |
| À surveiller | Chantiers en cours dont la date de fin est dépassée |
| À surveiller | Demandes d'absence à valider |
| Info | Factures à échéance sous 7 jours, articles sous le seuil de stock, consultations à traiter |

- Bouton **Analyser et proposer des actions** : l'assistant commente le briefing et peut préparer des actions (IA-2),
  toujours à confirmer.
- **Pastille rouge** sur l'entrée « Assistant IA » du menu : nombre d'alertes urgentes et à surveiller.
- Outil `briefing_du_jour` pour l'assistant ; point d'accès `GET /api/assistant/copilote/briefing` (même garde qu'IA-1).
- Jour de référence : jour civil à Paris.

---

# IA-4 : mode terrain (voix et photos)

- **Dictée** : bouton micro du panneau (reconnaissance vocale du navigateur, en français). Le texte reconnu s'ajoute à la
  question, que l'utilisateur relit avant d'envoyer. Aucun son n'est envoyé à Planificator. Bouton masqué si le navigateur
  ne gère pas la dictée (dans l'appli iPhone, le micro du clavier reste disponible).
- **Photo** : bouton appareil photo (caméra arrière sur téléphone, ou galerie). La photo est réduite dans le navigateur
  (1600 px, JPEG, métadonnées et position GPS retirées), jointe au message suivant et transmise à Claude pour ce seul
  message. Elle n'est conservée ni sur le serveur ni dans l'historique envoyé ensuite.
- **Lecture à voix haute** des réponses (synthèse vocale du navigateur), activable dans l'en-tête du panneau ;
  réglage mémorisé sur l'appareil.

Contrôles serveur de la photo (`parseImage`) : JPEG, PNG ou WebP seulement, base64 strict, signature du format
cohérente, 3,5 millions de caractères au plus. Le prompt rappelle que le texte visible sur une photo est une information,
jamais une instruction.

---

# IA-5 : automatisations écrites en français

L'utilisateur décrit une automatisation en français (« quand un devis est accepté, crée une tâche pour planifier le
chantier dans 2 jours »). L'assistant la traduit en règle du **module Automatisations existant** et affiche une carte
« Je confirme ». La confirmation crée la règle **en brouillon** via `createRuleAction` : elle n'agit qu'après
l'approbation habituelle dans la page Automatisations (deux étapes, comme à la main).

- Liste fermée du module : déclencheurs « changement d'étape d'une opportunité » (filtre d'étape facultatif), « relance
  d'opportunité arrivée à échéance », « devis accepté » ; actions « créer une tâche interne », « notifier les
  administrateurs ». Champs de modèle : `{numero} {titre} {client} {chantier} {etape} {date}`.
- Validation identique au formulaire (`validateRule`), déclencheurs du pipeline commercial refusés si celui-ci est coupé,
  responsable vérifié dans la société.
- Une demande hors liste (« chaque lundi », envoi de courriel…) est expliquée, avec la règle la plus proche si elle a du
  sens.
- Outil de lecture `automatisations` : règles existantes, pour éviter les doublons.
- Outil offert seulement si `AUTOMATIONS_ENABLED=true` (et IA-2 active).

---

# IA-6 : rôle maître et ouverture aux autres rôles

## Chaque rôle limité à ses droits

| Rôle | Outils (lecture seule) | Où |
|---|---|---|
| Administrateur | Tous les outils de la société, actions IA-2 / IA-5, briefing IA-3, expert | Menu « Assistant IA » |
| Chef d'équipe | `mon_planning`, `mes_absences`, `planning_equipe`, `affectations_a_confirmer`, `absences_equipe` (équipes qu'il dirige) | Menu « Assistant IA » |
| Employé | `mon_planning`, `mes_absences` | Menu « Assistant IA » |
| Client | `mes_chantiers` (ses chantiers et prochaines interventions) | Bouton « Assistant » du portail client |

- La fiche employé (rôles internes) ou la fiche client (`ClientProfile`, sinon courriel comme le portail) est résolue
  côté serveur depuis la session ; le modèle ne fournit jamais ces identifiants.
- Seuls les outils offerts au rôle peuvent s'exécuter : toute autre demande est refusée par le serveur.
- Pas de briefing, de pastille, d'action ni d'expert hors administration ; les points d'accès d'action et de briefing
  restent réservés à l'administration.
- Ouverture progressive : `COPILOT_ROLES` (ex. `ADMIN,SUPER_ADMIN,TEAM_LEADER`) ; absent = administration seule.
  Le quota quotidien reste celui de la société.

## Rôle maître et experts

L'assistant principal (Claude Haiku 5.5) répond aux questions courantes. Pour une question difficile, il appelle
`consulter_expert` : un expert du domaine (planning, commercial, finance, RH, stock) tourne sur **Claude Sonnet 5.5**,
avec les seuls outils de lecture de son domaine, puis le maître reformule et prépare lui-même les actions.

- Une consultation au plus par question ; elle compte une question de plus dans le quota (refusée si le quota est atteint).
- L'expert ne propose aucune action et ne peut pas consulter d'expert.
- Administration seule, drapeau `COPILOT_EXPERT_ENABLED=true` (désactivé par défaut).
