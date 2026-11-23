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
