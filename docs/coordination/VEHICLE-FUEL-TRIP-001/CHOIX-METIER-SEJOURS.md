# Séjours planifiés — choix métier à trancher par Nizar

> **R5 (4 novembre 2026) — décisions validées par Nizar et intégrées** : recommandations de Codex (R4,
> CHOIX-METIER-SEJOURS-CODEX.md) retenues : choix explicite un aller-retour / retours quotidiens ; décision par coupure
> (sur place / retour), sans fusion automatique ; transfert en journée bloqué puis déclaration explicite consignée à la
> sauvegarde de la dépense ; historique requis ; 62 jours civils et bornes connues ; chef actuel ; siège confirmé.
> Détail : IMPLEMENTATION.md, section R5. Le texte ci-dessous est l'analyse R4 d'origine, conservée.

R4, 4 novembre 2026. **Aucune décision n'est prise ni codée dans ce lot** : le code R3 reste conservateur (un séjour
douteux est listé « non estimable » avec sa raison, jamais estimé sur une supposition). Les recommandations ci-dessous
sont des propositions ; chacune élargirait la couverture et demanderait un lot dédié, des tests et une recette.

Règle actuelle (`src/lib/vehicules/v3/fuel-estimate-domain.ts`, `resolveStays`) : jours de planning de l'équipe qui
détient le camion ce jour-là, sur 60 jours passés et 60 à venir, regroupés par chantier et équipe, découpés en suites de
jours **consécutifs** ; une suite = un aller siège → chantier le premier jour et un retour le dernier jour.

## 1. Camion réaffecté en cours de journée (`HANDOVER`)

Aujourd'hui : si le camion change d'équipe ou de chauffeur pendant un jour du séjour (ou la veille / le lendemain
planifiés), le séjour est bloqué. Minuit (Paris) sert seulement à regrouper les jours, jamais à attribuer un coût.

| Option | Effet | Risque |
|---|---|---|
| A. Garder le blocage (actuel) | Aucun coût faux | Séjours sans estimation, saisie manuelle |
| B. Jour à l'équipe qui a le camion à minuit | Estimation automatique | Coût attribué à la mauvaise équipe si la bascule est le matin |
| C. Jour à l'équipe qui a le camion le plus longtemps ce jour | Plus juste en moyenne | Heures de bascule rarement saisies avec précision |
| D. Choix explicite par l'opérateur, tracé | Juste et vérifiable | Un clic de plus |

**Recommandation : A par défaut, puis D** (« attribuer ce jour à l'équipe … », journalisé). Pas de règle silencieuse.

## 2. Camion sans historique d'affectation (`NO_HISTORY`)

Aujourd'hui : aucune période enregistrée → bloqué ; l'équipe actuelle n'est pas une preuve pour des jours passés.

| Option | Effet | Risque |
|---|---|---|
| A. Garder le blocage (actuel) | Aucun coût faux | Camions anciens sans estimation |
| B. Supposer l'équipe actuelle, libellé « supposée » (comportement R2) | Couverture immédiate | Faux si le camion a changé d'équipe |
| C. Ouvrir l'historique : estimable à partir de la première période enregistrée | Juste, progressif | Il faut saisir ou importer l'historique |

**Recommandation : C** (avec A avant la première période). B seulement pour les jours **à venir**, si Nizar l'accepte.

## 3. Limite de 62 jours et fenêtre ±60 jours (`TOO_LONG`, `OUT_OF_RANGE`)

Aujourd'hui : séjour > 62 jours bloqué ; séjour qui touche le bord de la fenêtre lue bloqué (vrai départ ou retour
inconnu). Les deux évitent d'inventer un aller ou un retour.

| Option | Effet | Risque |
|---|---|---|
| A. Garder 62 j / ±60 j (actuel) | Simple, liste = détail | Très longs chantiers non estimés |
| B. Élargir (ex. 120 j, fenêtre ±150 j) | Plus de séjours couverts | Requêtes plus lourdes, à mesurer |
| C. Longs chantiers : rotations déclarées (ex. un aller-retour par semaine) | Proche du terrain | Convention à valider par chantier |

**Recommandation : A tant que les données réelles ne montrent pas de séjours plus longs ; sinon C**, déclaré par
l'utilisateur, plutôt qu'un plafond plus grand.

## 4. Chef d'équipe historique

Aujourd'hui : chef **actuel** affiché, libellé « chef d'équipe actuel (aujourd'hui, pas forcément pendant le séjour) ».
Aucun historique des chefs n'existe dans le schéma.

| Option | Effet | Risque |
|---|---|---|
| A. Garder le libellé actuel | Honnête, sans migration | Pas de chef daté |
| B. Historiser les changements de chef | Chef exact par jour | Migration de schéma et saisie |
| C. Retenir le chauffeur de la période du camion | Déjà daté | Ce n'est pas le chef |

**Recommandation : A**, B seulement si l'attribution par chef sert à la facturation ou à la paie.

## 5. Week-ends et jours non planifiés

Aujourd'hui : une interruption du planning (ex. samedi et dimanche non planifiés) coupe le séjour en deux ; chaque
partie compte un aller et un retour (l'équipe est supposée rentrer). Exemple du jeu de recette : jeudi → jeudi sans
week-end planifié = deux séjours estimables.

| Option | Effet | Risque |
|---|---|---|
| A. Garder la coupure (actuel) : retour au dépôt à chaque interruption | Juste si l'équipe rentre le week-end | Surestime si l'équipe reste sur place |
| B. Relier les interruptions courtes (≤ 2 jours) : un seul aller-retour | Juste en grand déplacement | Sous-estime si l'équipe rentre |
| C. Réglage par société ou par chantier « l'équipe rentre le week-end : oui / non » | Fidèle au terrain | Un réglage à tenir à jour |

**Recommandation : C, avec « oui » par défaut** (= comportement actuel).

## 6. Hypothèse aller-retour depuis le dépôt

Aujourd'hui : départ et retour au siège de la société (`PLANNED_MILEAGE_DEPOT`), un seul aller et un seul retour par
séjour ; les trajets quotidiens d'un chantier proche, les départs du domicile et les enchaînements chantier → chantier ne
sont pas comptés. Un champ facultatif « déplacements sur place » ajoute des kilomètres.

| Option | Effet | Risque |
|---|---|---|
| A. Garder + « déplacements sur place » (actuel) | Simple, corrigeable | Sous-estime les chantiers proches |
| B. Aller-retour quotidien sous un seuil de distance (ex. < 50 km) | Plus juste pour le local | Seuil arbitraire, à valider |
| C. Choix par séjour « trajets quotidiens / un seul aller-retour » | Juste | Un choix de plus |

**Recommandation : A, puis C si les chantiers proches sont fréquents.** Le ticket réel reste la référence : une
estimation n'est jamais une dépense payée et reste « À valider ».

## À décider par Nizar

1. Réaffectation en journée : A seul, ou A puis D ?
2. Sans historique : C ? B accepté pour les jours à venir ?
3. Plafond : A, ou C pour les longs chantiers ?
4. Chef : A suffit-il ?
5. Week-ends : C avec « rentre le week-end : oui » par défaut ?
6. Dépôt : A, puis C ?
