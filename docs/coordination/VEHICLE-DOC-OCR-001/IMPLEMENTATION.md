# VEHICLE-DOC-OCR-001 — Lecture automatique des pièces véhicule (note de réalisation, 4 nov. 2026)

Branche locale `feat/vehicle-documents-ocr` (base `origin/main` `2dd32e9`). **Rien n'est poussé, fusionné, déployé ni
activé ; aucune donnée de production n'est lue ni modifiée.**

## Décisions (arbitrées par Nizar le 4 nov. 2026)

- Moteur OCR local existant (module RH `src/lib/hr-documents/recognition/ocr.ts`, inchangé) : couche texte du PDF,
  sinon Tesseract WASM avec modèles embarqués. Aucune API payante, aucun envoi à un tiers.
- Aucune migration : seuls les champs existants de la version sont préremplis ; immatriculation et marque sont
  comparées à la fiche ; 1re immatriculation, montant TTC, litres et kilométrage du contrôle sont proposés comme lignes
  d'« Observations », modifiables.
- Lecture automatique dès le choix du fichier, sans écraser une saisie manuelle.
- Toute pièce reste « À vérifier » : la lecture n'écrit rien ; `verifiedAt` n'est rempli que par « Marquer comme vérifié ».
- Aucune dépense créée, aucun compteur modifié.

## Drapeau

```
PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED=true   # absent = comportement actuel strict
```

Il exige aussi `PLANIFICATOR_VEHICLES_V3_ENABLED=true`. Ne pas confondre avec `PLANIFICATOR_VEHICLE_OCR_ENABLED`, qui
pilote l'IA payante de l'import d'adresses et n'est pas utilisé ici.

## Ce qui a été construit

| Fichier | Rôle |
|---------|------|
| `src/lib/vehicules/v3/document-recognition-domain.ts` | Règles pures par rubrique : carte grise (I, C.1, numéro de formule, A, B, D.1 ; C.3 jamais lu), assurance et carte verte, contrôle technique, facture de garage, ticket de carburant. Confiance par champ « lu » / « à vérifier ». Rubrique probable signalée, jamais reclassée. |
| `src/lib/vehicules/v3/document-recognition-service.ts` | Drapeau, session, droits relus en transaction (administrateur de l'entreprise de la session, camion actif, rubrique visible), contrôle du fichier identique au dépôt (signature, extension, PDF actif, 4 Mio), une lecture à la fois par instance (429), délai de lecture 25 s et réponse au plus tard à 30 s, aucune écriture, texte brut jamais renvoyé. |
| `src/app/api/trucks/[id]/documents/recognize/route.ts` | `POST` multipart `file` + `payload` `{category}` ; `maxDuration = 60`. |
| `src/lib/vehicules/v3/document-api.ts` | Drapeau et droits vérifiés **avant** la lecture du corps. |
| `src/components/vehicules/v3/vehicle-document-recognition-ui.ts` | Fusion pure dans le formulaire, remise à l'état d'ouverture au changement de fichier, garde « dernière lecture seulement », messages. |
| `src/components/vehicules/v3/VehicleDocumentsTab.tsx` | Lecture au choix du fichier ; réponse ignorée et requête annulée si le fichier change ou si le formulaire est fermé ou rouvert ; champ saisi = jamais réécrit ; marques « lu » / « à vérifier » ; contrôles plaque et marque. |
| `VehicleSheet.tsx`, `vehicules/[id]/page.tsx` | Drapeau lu côté serveur, transmis seulement aux administrateurs. |
| `next.config.ts` | Moteur WASM et modèles tracés pour la nouvelle route (clé en motif `/api/trucks/*/documents/recognize`). |

## Preuves (locales, documents synthétiques uniquement)

| Contrôle | Résultat |
|----------|----------|
| `tests/vehicules/v3/document-recognition.test.ts` | **29 / 29** : 11 règles (6 rubriques, plaque et marque divergentes, pas d'échéance sur carte grise, rubrique douteuse, faible confiance, textes vides ou hostiles, dates impossibles) ; 9 route (drapeau, prototype V3 éteint, réponse sans texte ni adresse, chef 403, autre entreprise 404, camion archivé 409, origine 403, payload 400, 4 fichiers refusés avant lecture, 429 puis libération, 502 sans détail, échec technique sans champ, aucune valeur journalisée, aucune écriture en base) ; 7 formulaire (pas d'écrasement, remplacement, observations complétées, proposition d'une autre rubrique ignorée, remise à l'état d'ouverture, jeton périmé, messages) ; 2 lectures Tesseract réelles (photo JPEG et scan PDF de carte grise fictive ; photo floue et tournée d'attestation fictive) |
| `npm run test:vehicules` | 219 + 178 + 177 + 9, tout vert |
| `npm run test:hr-documents` | 65 / 65 (module OCR partagé inchangé) |
| `tsc --noEmit` | 52 diagnostics, tous antérieurs ; aucun dans les fichiers du lot |
| `npm run build` | réussi ; trace de la route : 2 modèles `best_int`, 6 variantes `tesseract-core*.wasm`, aucun modèle `4.0.0`, ≈ 59 Mo tracés (comme la route RH) |
| Navigateur local (base Docker jetable `planificator_vehicle_ocr`, compte admin du seed, camion fictif AB-123-CD) | PDF d'assurance : 4 champs préremplis, assureur saisi à la main conservé, plaque « identique » ; photo de carte grise : date I, numéro de formule, titulaire « à vérifier » (bordure ambre), plaque et marque contrôlées, adresse C.3 absente, 1,4 à 1,6 s ; formulaire fermé pendant la lecture → requête annulée, rien appliqué à la réouverture ; changement de fichier → valeurs précédentes effacées, rubrique douteuse signalée ; 375 px sans défilement horizontal ; journaux du serveur sans aucune valeur lue |

## Non vérifié / limites

- **Vercel non prouvé.** Aucun essai réel : ni taille de la fonction déployée, ni démarrage à froid (chargement des
  modèles, plusieurs secondes possibles), ni mémoire (≈ 100 Mo par instance chaude d'après le lot RH), ni durée. La route
  RH qui partage ce moteur n'a enregistré **aucun appel en production** sur les 2 derniers jours : son fonctionnement sur
  Vercel n'est pas démontré non plus.
- **Coût serveur.** Pas d'API payante, mais chaque lecture consomme du temps de calcul de fonction Vercel (de 1 à
  quelques secondes par page, plus le démarrage à froid) : un coût d'exécution existe, à surveiller sous le plafond de 30 $.
- Limite « une lecture à la fois » **par instance** seulement : plusieurs instances peuvent lire en parallèle ; pas de
  quota par utilisateur ou par entreprise.
- Une requête annulée par le navigateur n'interrompt pas la lecture déjà lancée sur le serveur : elle se termine (dans
  le délai borné), puis sa réponse est jetée.
- Règles fondées sur des textes synthétiques : les vraies cartes grises, attestations et tickets varient (mise en page,
  libellés, qualité de photo). Les tickets thermiques pâles, les photos de travers (au-delà de 90°) et les PDF
  vectoriels sans texte ni image restent mal ou pas lus ; la saisie manuelle reste possible. HEIC refusé (comme le dépôt).
- Le moteur RH tente aussi une lecture MRZ (pièces d'identité), inutile ici : elle allonge un peu la lecture des images.
  Non modifié pour ne pas toucher au module RH.
- Le fournisseur « en-tête de facture » est une déduction (première ligne plausible) : toujours « à vérifier ».
- Safari / iOS sur appareil réel, et lecteurs d'écran : non essayés.
- Revue indépendante du code : non faite.

## Pour activer plus tard (non fait)

1. Essai sur la préproduction (`planificator-staging`) : nécessite un push, donc des builds Vercel, à arbitrer.
2. Positionner `PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED=true` sur l'environnement d'essai seulement.
3. Mesurer démarrage à froid, durée et mémoire dans les journaux runtime, puis décider pour la production.
