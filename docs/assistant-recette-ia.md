# Assistant IA — recette par rôle (IA-1 à IA-6)

| Champ | Valeur |
|---|---|
| **Statut** | Recette hors production FAITE le 24/11/2026 ; recette en production À FAIRE (comptes réels nécessaires) |
| **Code** | `main` à `b656a82` (IA-6, PR #219) |
| **État en production** | Copilote, actions, expert et quatre rôles activés (`COPILOT_ROLES=ADMIN,SUPER_ADMIN,TEAM_LEADER,EMPLOYEE,CLIENT`), quota 200 questions par jour et par société |

## 1. Recette hors production (faite)

Base PostgreSQL jetable locale (Docker, `127.0.0.1` seulement), 117 migrations appliquées, deux sociétés aux données
jumelles (mêmes noms d'équipes, de chantiers et de clients). Vraies requêtes Prisma, aucune IA, aucun appel réseau.

```
TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
  sh tests/billing/pg/with-disposable-db.sh copilot npm run test:copilot:pg
```

Résultat : **11 scénarios sur 11 conformes** (`tests/copilot/pg/copilot-roles.pg.test.ts`).

| Contrôle | Résultat |
|---|---|
| Fiche employé et fiche client résolues depuis la session ; fiche inactive ignorée ; compte présenté avec une autre société : aucune fiche | Conforme |
| Employé : son planning et ses absences seulement ; outils de chef et de client refusés | Conforme |
| Chef d'équipe : planning, affectations à confirmer et absences de SES équipes, jamais de l'équipe d'un autre chef | Conforme |
| Client : ses chantiers seulement (par profil, ou par courriel comme le portail) ; jamais les chantiers d'un autre client | Conforme |
| Administrateur : planning, équipes, briefing limités à sa société | Conforme |
| Confirmation simultanée d'une même carte « Je confirme » : une seule exécution ; libérée après échec, elle redevient possible | Conforme |
| Quota quotidien : par société, sans débordement entre sociétés, sans dépassement en accès simultanés | Conforme |

Complément : `npm run test:copilot` (61 tests, sans base) couvre le prompt par rôle, le refus d'un outil hors rôle par
la boucle, les cartes signées (jeton modifié, expiré, d'un autre utilisateur), la photo et l'expert.

## 2. Recette en production (à faire, avec l'accord de Nizar)

### Prérequis

| Compte | Condition |
|---|---|
| Administrateur | Compte de Nizar, société GALYA EVENTS |
| Chef d'équipe | Compte `TEAM_LEADER` relié à une fiche employé ACTIVE qui dirige au moins une équipe avec des affectations dans les 7 prochains jours |
| Employé | Compte `EMPLOYEE` relié à une fiche employé ACTIVE, avec au moins une affectation à venir et, si possible, une absence |
| Client | Compte `CLIENT` relié à sa fiche client (`ClientProfile`, ou courriel identique à celui de la fiche) avec au moins un chantier |

Chaque essai consomme une question du quota (deux avec l'expert). Une affectation confirmée envoie notification et
courriel au chef d'équipe : choisir une équipe et une date sans conséquence, puis retirer l'affectation.

### Scénarios

Noter pour chaque ligne : conforme / écart, avec une capture en cas d'écart.

**Administrateur**

| # | Action | Attendu |
|---|---|---|
| A1 | Menu « Assistant IA » sous « Dashboard » | Panneau ouvert, briefing du jour, pastille si alertes urgentes ou à surveiller |
| A2 | « Qui travaille demain et sur quel chantier ? » | Réponse exacte, liens cliquables vers les chantiers |
| A3 | « Crée une tâche pour relancer la mairie vendredi » | Carte « Créer une tâche » ; rien n'est créé avant « Je confirme » ; après confirmation, tâche visible |
| A4 | Cliquer deux fois « Je confirme » sur la même carte | Une seule tâche ; second clic : « déjà confirmée » |
| A5 | « Prépare un devis pour <chantier> avec 2 <article> » | Carte avec totaux HT et TTC ; brouillon créé, jamais envoyé |
| A6 | « Quand un devis est accepté, crée une tâche pour planifier le chantier dans 2 jours » | Carte « règle d'automatisation » ; règle en brouillon dans Automatisations |
| A7 | « Organise la semaine prochaine pour mes équipes » | Réponse structurée issue de l'expert planning (réponse plus lente) |
| A8 | Photo d'un ticket ou d'un bon de livraison (téléphone) | Montants, dates et références lisibles relevés |
| A9 | Micro (téléphone, Safari ou Chrome) | Texte dicté écrit dans la case, à relire avant envoi |

**Chef d'équipe**

| # | Action | Attendu |
|---|---|---|
| C1 | Menu « Assistant IA » | Panneau sans briefing ni pastille ; sous-titre « Consultation seule » |
| C2 | « Où travaille mon équipe cette semaine ? » | Affectations de SES équipes seulement |
| C3 | « Quelles affectations dois-je confirmer ? » | Liste des affectations en attente de ses équipes |
| C4 | « Montre-moi les factures en retard » | Refus poli : information non accessible à son rôle |
| C5 | « Où travaille l'équipe <équipe d'un autre chef> ? » | Aucune donnée de cette équipe |

**Employé**

| # | Action | Attendu |
|---|---|---|
| E1 | « Où est-ce que je travaille demain ? » | Son affectation seulement |
| E2 | « Où travaille <collègue> demain ? » | Aucune donnée sur le collègue |
| E3 | « Pose-moi un congé lundi » | Explique la rubrique « Mes absences » ; rien n'est créé |

**Client (portail client)**

| # | Action | Attendu |
|---|---|---|
| L1 | Bouton « Assistant » en bas à droite du portail | Panneau ouvert, suggestions client |
| L2 | « Où en sont mes chantiers ? » | Ses chantiers et prochaines interventions seulement |
| L3 | « Quels sont vos autres clients ? » ou « Quel est votre prix interne ? » | Refus poli, invitation à contacter son interlocuteur |

### Retour en arrière (un seul réglage, sans code)

| Effet voulu | Réglage Vercel (Production), puis redéploiement |
|---|---|
| Fermer un rôle | Retirer le rôle de `COPILOT_ROLES` (absent = administration seule) |
| Couper l'expert | `COPILOT_EXPERT_ENABLED` ≠ `true` |
| Couper les actions | `COPILOT_ACTIONS_ENABLED` ≠ `true` (l'assistant reste en lecture seule) |
| Couper l'assistant | `COPILOT_ENABLED` ≠ `true` (plus de bouton, points d'accès en 404) |
