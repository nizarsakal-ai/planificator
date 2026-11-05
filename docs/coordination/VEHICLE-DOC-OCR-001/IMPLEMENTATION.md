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

## Corrections R2 après revue Codex R1 (NO-GO), 4 nov. 2026 — non revues à ce jour

Plusieurs affirmations ci-dessus sont **remplacées** : « C.3 jamais lu », « module OCR inchangé », « délai 25 s et
réponse à 30 s » comme borne suffisante.

- **C.1 / C.3 (point 4)** : le titulaire est coupé au code suivant quelle que soit la ponctuation (`C.3:`, `C.3 :`,
  `(C.3)`, `C,3`, `C3`, collé `FICTIVEC.3:`, lignes fusionnées, autres codes D.1, E, F.1…). S'il reste un fragment
  d'adresse (numéro + voie, code postal, BP, CEDEX…), **aucun titulaire n'est proposé**. Même coupe sur la marque D.1.
- **Montant TTC (point 7)** : la marque HT/TVA est cherchée avant le montant retenu, sur la ligne du libellé et sur la
  ligne suivante quand le montant y est lu, ainsi qu'après le montant. « TOTAL » ou « MONTANT » sans preuve TTC devient
  « Montant total lu (TTC non indiqué, à vérifier) ».
- **Borne réelle (point 3)** :
  - moteur Tesseract propre aux pièces véhicule (`document-recognition-engine.ts`), distinct de celui des documents RH ;
  - à l'échéance, lecture abandonnée par signal, **workers terminés**, puis place rendue (délai de grâce de 3 s au plus) ;
  - une lecture qui ne finit pas malgré tout reste comptée « abandonnée » : au-delà de deux lectures non finies, 429 ;
  - le moteur est rechargé à la lecture suivante (reprise) ;
  - dimensions des images d'un PDF lues dans leurs dictionnaires **avant décompression** : plus de 25 Mpx (ou 75 Mpx au
    total), ou taille inconnue (indirecte) → `PDF_IMAGE_TOO_LARGE`, sans extraction ni OCR ;
  - module RH : modifications rétrocompatibles et optionnelles (`signal`, `maxPdfImagePixels`, `createOcrEngineHandle`),
    sans effet sur le parcours RH quand elles sont absentes ; 65 / 65 tests RH rejoués.

### Limites restantes (R2)

- Non préemptible : une opération native déjà lancée (décodage sharp/libvips, extraction d'images pdf.js) se termine
  d'elle-même, bornée par les tailles ci-dessus ; les images « en ligne » d'un flux de contenu compressé ne sont pas
  pré-contrôlées (bombe de décompression d'un flux de contenu non couverte).
- Deux moteurs OCR peuvent coexister sur une instance (RH et véhicule) : ≈ 2 × 100 Mo au pire.
- Limite par instance : plusieurs instances Vercel peuvent lire en parallèle. Aucune preuve Vercel : tests locaux seulement.
- Diagnostic TypeScript et build non exécutés en R2 (permissions de cette session).

### Corrections R2.1 après contrôle Codex de R2, 4 nov. 2026

- R2 attendait `engine.kill()` sans échéance avant le délai de grâce : un chargement ou un `terminate` bloqués
  bloquaient la réponse. Désormais l'arrêt est seulement **demandé** ; lecture et arrêt sont attendus ensemble au plus
  le délai de grâce, puis 504. Le travail est compté « non terminé » dès l'échéance et le reste tant que la lecture **ou**
  l'arrêt du moteur ne sont pas finis (même si la lecture a déjà rendu `TIMEOUT` sur le signal) : au plus deux
  travaux non finis, donc au plus deux moteurs véhicule non arrêtés par instance ; au-delà, 429. Place rendue dès la fin
  réelle (reprise).
- Moteur : `kill()` oublie le moteur courant immédiatement ; un chargement tardif est terminé dès qu'il se résout ; un
  ancien chargement en échec n'efface plus le handle d'un moteur plus récent.
- Non préemptible (inchangé, précisé) : un chargement ou un `terminate` qui ne finissent jamais ne sont pas tués ; leur
  place reste occupée. Contrôle `tsc --project tsconfig.vehicules.json --noEmit` exécuté : aucune erreur.

### R3 — isolation interrompable de tout le traitement à risque, 4 nov. 2026

- Par défaut, la lecture (couche texte PDF, analyse et extraction d'images, décodage sharp, chargement et calcul
  Tesseract) s'exécute dans un **processus Node enfant neuf par lecture** (`src/lib/vehicules/v3/ocr-isolation/`),
  tué par **SIGKILL** à l'abandon (échéance de réponse) ou à l'échéance absolue du parent : le calcul s'arrête réellement,
  y compris en natif/WASM. La promesse ne se résout qu'à la fin réelle du processus (`exit`) : la place « non terminée »
  est rendue en quelques millisecondes ; plus de 429 durable (5 lectures bloquées de suite → 5 × 504, 0 compté ensuite).
- Ressources : tas JS de l'enfant `--max-old-space-size=256` ; chien de garde dans un fil `worker_threads` de l'enfant
  (SIGKILL au-delà de 768 Mo de mémoire résidente, à l'échéance absolue, ou si le parent disparaît) qui fonctionne même
  fil principal bloqué ; `sharp.concurrency(1)`, cache sharp coupé ; environnement de l'enfant réduit à 3 variables
  (aucun secret transmis) ; sorties standard fermées ; réponse de l'enfant validée strictement.
- Empaquetage : `node scripts/build-vehicle-ocr-worker.mjs [sortie]` (esbuild, CommonJS ; `sharp`, `tesseract.js`,
  `unpdf`, `@tesseract.js-data/*` externes, résolus depuis `node_modules`). Chemin lu : `VEHICLE_OCR_WORKER_PATH`
  (absolu) ou `<cwd>/.vehicle-ocr-worker/worker.cjs`. **Empaquetage absent : 503 `RECOGNITION_UNAVAILABLE`**, message
  explicite dans le formulaire ; jamais de repli silencieux sur une lecture dans le serveur. Le mode « dans le serveur »
  (R2.1) ne subsiste que par injection d'un moteur (tests).
- Non fait (activation) : brancher l'empaquetage sur le build ; embarquer `.vehicle-ocr-worker/**` et les dépendances
  externes via `outputFileTracingIncludes` de `next.config` ; vérifier que la plateforme autorise `child_process.fork`.
- Limites : la mémoire résidente est échantillonnée (25 ms) ; un pic entre deux mesures peut dépasser la limite avant le
  SIGKILL ; un processus bloqué dans le noyau ne meurt qu'à son retour ; démarrage d'un processus et de Tesseract à
  chaque lecture (≈ 1 à 3 s) ; aucune preuve Vercel (fork, mémoire, traçage des fichiers non éprouvés).

### R3.1 — cycle de vie du processus isolé, 4 nov. 2026

- Défaut relevé par Codex : un `fork` qui ne démarre pas (aucun pid : ENOENT, EAGAIN, EPERM…) émet `error` sans `exit` ;
  la lecture restait pendante. Corrigé : démarrage raté (ou exception de `fork`) → échec technique immédiat, sans
  attendre `exit` ; résolution unique ; minuteries et écouteur d'abandon retirés ; erreurs tardives absorbées.
- Enfant démarré : toute erreur (signal, envoi IPC en échec par exception ou par rappel) déclenche SIGKILL, et la
  résolution attend TOUJOURS sa fin réelle (`exit`) ; la place n'est jamais rendue tant qu'il vit.
- Tests : contre-exemple Codex rejoué, envoi en échec avec arrêt différé (place tenue jusqu'à la vraie fin), erreurs en
  double, exception de `fork`, compteurs du service exacts et reprise.

### R4 — empaquetage branché et fermeture vérifiée localement, 4 nov. 2026

- `npm run build` = `prisma generate && node scripts/build-vehicle-ocr-worker.mjs && next build` ; `npm run dev` empaquette
  aussi avant `next dev` (pas de reconstruction à chaud : relancer dev après modification du processus de lecture).
- Le script écrit `.vehicle-ocr-worker/worker.cjs` et `.vehicle-ocr-worker/trace.json` (ignorés par git) : fermeture
  calculée par `@vercel/nft` (livré avec Next) + cœurs WASM Tesseract et modèles `4.0.0_best_int` lus par chemin ; les
  modèles `4.0.0` non utilisés sont retirés. Chemin hors `node_modules`, motif ou fichier absent : build en échec.
- `next.config.ts` (`vehicleOcrWorkerTraceIncludes`) ajoute le processus et chaque fichier du manifeste à
  `outputFileTracingIncludes` de `/api/trucks/*/documents/recognize` ; manifeste absent : rien (route 503) ; invalide ou
  incomplet (fichier listé absent) : configuration en échec. Route RH inchangée.
- `esbuild` 0.28.0 déclaré en dépendance de développement (déjà verrouillé et installé via `tsx`) ; seule la racine du
  verrou change, aucune installation. `sharp` reste en dépendance de développement (voir limites).
- Vérification : `npm run verify:vehicle-ocr-worker` copie le processus et les seuls fichiers du manifeste dans un dossier
  temporaire sans `node_modules` ancêtre, lit un PDF à couche texte et une image (OCR réel) par le lecteur de production
  (cwd = la copie, environnement réduit), puis vérifie que la copie privée des cœurs WASM ou de sharp échoue.
- Limites : fermeture calculée pour la plateforme de build (binaires natifs sharp de la machine) ; taille ≈ 40 Mo en
  local ; `sharp` en devDependencies (installé sur Vercel au build, mais ses binaires `@img/*` sont marqués « dev » dans le verrou et un `npm ci --omit=dev` les omettrait : le déplacer
  en dépendance exige une installation, non autorisée ici) ; aucun build Next exécuté ; aucune preuve Vercel (fork,
  mémoire, cwd de la fonction, taille du paquet).

## Pour activer plus tard (non fait)

1. Essai sur la préproduction (`planificator-staging`) : nécessite un push, donc des builds Vercel, à arbitrer.
2. Positionner `PLANIFICATOR_VEHICLE_DOCUMENT_RECOGNITION_ENABLED=true` sur l'environnement d'essai seulement.
3. Mesurer démarrage à froid, durée et mémoire dans les journaux runtime, puis décider pour la production.
