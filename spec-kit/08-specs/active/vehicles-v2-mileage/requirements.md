# Exigences — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Chaque exigence doit être reliée à **implémentation → test → preuve** dans `acceptance.md`.

## Exigences demandées par l'utilisateur

| ID | Exigence |
|----|----------|
| **V2-MIL-001** | Un véhicule possède un kilométrage courant. |
| **V2-MIL-002** | Un trajet peut enregistrer un kilométrage de départ. |
| **V2-MIL-003** | Un trajet peut enregistrer un kilométrage d'arrivée. |
| **V2-MIL-004** | distance réelle = arrivée − départ. |
| **V2-MIL-005** | arrivée ≥ départ. |
| **V2-MIL-006** | L'historique doit être tenant-scoped. |
| **V2-MIL-007** | Le chantier peut fournir le contexte du déplacement. |
| **V2-MIL-008** | La distance géographique d'un chantier ne constitue jamais le kilométrage réellement parcouru. |

## Précisions d'interprétation à valider (DÉCISION REQUISE)

- 001 : « courant » = valeur nullable tant qu'aucun relevé n'existe (un véhicule existant n'a pas de kilométrage connu ; **aucun backfill inventé**).
- 002/003 : « peut » = optionnel ; un trajet sans kilométrage reste valide. La distance réelle n'est calculable que si les **deux** valeurs sont présentes.
- 004 : la distance est **dérivée** (jamais saisie ni stockée comme donnée source).
- 005 : garantie **en base** (CHECK) **et** dans l'API (erreur typée).
- 006 : toute lecture/écriture d'historique filtre par `companyId` de session ; une autre entreprise reçoit « introuvable ».
- 007 : le chantier est une **référence facultative** (contexte), n'influe sur aucun calcul de distance.
- 008 : aucun code ne dérive un kilométrage de latitude/longitude ni de la géolocalisation d'un chantier ; test dédié.

## Exigences proposées (non demandées — à accepter ou rejeter)

| ID | Proposition | Raison |
|----|-------------|--------|
| V2-MIL-P01 | Kilométrage entier ≥ 0 en km, avec plafond de plausibilité | Éviter les saisies aberrantes |
| V2-MIL-P02 | Tout relevé < kilométrage courant est refusé (409 `MILEAGE_REGRESSION`) ; le courant ne diminue donc jamais | Cohérence d'un odomètre |
| V2-MIL-P03 | **Ouverture** d'un trajet refusée sur un véhicule archivé (`TRUCK_ARCHIVED`, code existant) ; clôture d'un trajet déjà ouvert permise | Cohérence avec V1B sans bloquer un trajet commencé avant l'archivage |
| V2-MIL-P04 | Mise à jour du courant et du trajet sous verrou véhicule (`lockTrucks`) | Concurrence (voir `04-database/concurrency.md`) |
| V2-MIL-P05 | Un trajet ne peut pas se chevaucher avec un autre trajet **du même véhicule** | À débattre (peut être trop strict) |

## Hors périmètre rappelé

Vidange, contrôle technique, GPS, télématique (voir `spec.md`).
