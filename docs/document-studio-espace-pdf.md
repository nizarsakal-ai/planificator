# Document Studio : espace PDF

Guide d'utilisation et d'exploitation de l'espace PDF du Document Studio (lots 1 à 4, novembre 2026 :
nizarsakal-ai/planificator#174 et nizarsakal-ai/planificator#175).

L'espace PDF sert à travailler sur des PDF **reçus** (avis de paiement, bon de commande, contrat…) : les consulter, les
remplir et les signer, les annoter, réorganiser leurs pages, les combiner et biffer des informations. La génération de
documents à partir de modèles (« Nouveau modèle », « Générer un document ») est une autre partie du Studio, inchangée.

## 1. Utilisation

Accès : menu **Document Studio** (`/studio-documents`), comptes ADMIN ou SUPER_ADMIN, groupe d'outils
« Travailler sur un PDF ».

### Importer un PDF

1. Section **Importer un PDF** de l'accueil du Studio : choisir le fichier, titre facultatif (par défaut, le nom du fichier).
2. **Importer** ouvre la fiche du PDF.

- 4 Mo et 300 pages au maximum.
- Le fichier est conservé tel quel. Importer deux fois le même fichier rouvre la fiche existante.
- Un PDF protégé (chiffré) s'importe et se consulte, mais ne peut être ni modifié ni signé.

### Consulter et rechercher

- Zoom de 50 à 200 %, vignettes à gauche pour aller à une page, sélecteur de page, **Télécharger**.
- **Rechercher dans le document** : insensible aux majuscules et aux accents ; si l'expression exacte n'est pas trouvée,
  la page sort quand tous les mots y figurent. Un PDF scanné (sans couche texte) n'est pas cherchable.

### Remplir, signer, annoter

Bouton **Remplir et signer**, puis choisir un outil et cliquer sur la page :

| Outil | Geste | Résultat |
|---|---|---|
| Texte | clic, puis saisie | texte sur une ligne |
| Date | clic | date du jour (modifiable dans le panneau), au format JJ/MM/AAAA |
| Coche | clic | coche ✓ |
| Signature | tracer la signature dans le panneau, puis clic | signature manuscrite, avec le nom du signataire obligatoire |
| Surligner | glisser sur la zone | surlignage jaune transparent |
| Encadrer | glisser sur la zone | cadre rouge |
| Note | clic, puis saisie | texte sur fond jaune |

- Déplacer un élément : le faire glisser, ou flèches du clavier (Maj : plus vite). **Suppr** le retire.
- Taille : boutons − / + du panneau quand l'élément est sélectionné.
- Les caractères hors du jeu de la police PDF standard (émojis, ✓ tapé au clavier, etc.) sont refusés et signalés.
- **Enregistrer la version N** crée une nouvelle version. L'original et les versions précédentes ne changent jamais.

### Organiser, extraire, combiner

- **Organiser les pages** : grille des pages. Déplacer (flèches ou glisser-déposer), pivoter (↺ ↻), retirer (corbeille),
  **Tout annuler**. **Enregistrer la version N** crée une nouvelle version.
- **Extraire** : cocher des pages (l'ordre et la rotation affichés sont conservés), titre facultatif, puis **Extraire**.
  Cela crée un **nouveau PDF**, dont la fiche indique la source.
- **Combiner des PDF** (accueil du Studio) : ajouter 2 à 20 PDF, régler l'ordre, titre facultatif. La dernière version de
  chaque PDF est reprise dans un **nouveau PDF** ; les originaux ne changent pas.
- Les champs de formulaire interactifs, signets et pièces jointes du document d'origine ne sont pas repris quand on
  organise, extrait ou combine. Le contenu visible des pages, lui, est conservé.

### Biffer

1. Bouton **Biffer**, puis glisser sur la page pour tracer chaque zone noire. Cliquer une zone la sélectionne ; **Suppr** la retire.
2. **Préparer le biffage** : chaque page biffée est dessinée en image, zones noires comprises, et un aperçu s'affiche.
3. Vérifier l'aperçu, puis **Enregistrer la version N biffée**.

À savoir :

- Une page biffée est **remplacée par son image** : le texte caché est réellement supprimé de la nouvelle version. En
  contrepartie, plus aucun texte de cette page n'est sélectionnable ni cherchable. Les autres pages ne changent pas.
- **Les versions précédentes restent dans l'historique, en clair.** Le biffage protège le fichier téléchargé et partagé,
  pas ce qui est déjà stocké dans Planificator.
- 8 pages biffées au plus par enregistrement. Au-delà : enregistrer, puis continuer depuis la nouvelle version.

### Versions

En bas de la fiche, chaque version indique son type (original importé, remplie et signée, pages organisées, pages biffées,
PDF combiné, pages extraites), sa date, sa taille et son empreinte. On peut afficher ou télécharger chacune d'elles.
Remplir, organiser et biffer partent toujours de la **dernière** version. Si quelqu'un a enregistré entre-temps, un
message demande de recharger la page.

## 2. Exploitation

### Activation

- Drapeau : `DOCUMENT_STUDIO_ENABLED=true` (variables d'environnement Vercel du projet de production). Sans lui, les pages et
  routes du Studio répondent 404.
- Ordre de mise en service : **migrations d'abord, drapeau ensuite**. Avec le drapeau actif mais sans les tables, la page
  du Studio échoue avec l'erreur Prisma `P2021` (« The table `public.studio_pdfs` does not exist »).

### Migrations

| Migration | Contenu |
|---|---|
| `20261120120000_v2_studio_pdf_workspace` | tables `studio_pdfs` et `studio_pdf_revisions`, contraintes, déclencheurs |
| `20261120160000_v2_studio_pdf_redacted_kind` | valeur `REDACTED` du type de révision |
| `20261120160100_v2_studio_pdf_redacted_check` | contrainte de forme étendue à `REDACTED` |

Application, depuis le dossier du projet, avec l'adresse **directe** de la base de production (sans `-pooler`) :

```bash
DATABASE_URL='postgresql://…' npx prisma migrate deploy
```

Contrôle :

```bash
DATABASE_URL='postgresql://…' npx prisma migrate status
```

Le résultat attendu est `Database schema is up to date!`. Si une variable `DATABASE_URL` est déjà définie dans le shell,
elle passe avant le fichier `.env` : vérifier avec `echo "${DATABASE_URL:0:13}"` (doit afficher `postgresql://`).

### Données et garanties

- Fichiers stockés en base (`bytea`), avec l'empreinte SHA-256 revérifiée à chaque téléchargement (409 si elle ne
  correspond plus).
- Route des octets `/studio-documents/fichiers/<id>/revisions/<id>` : drapeau, rôle et société vérifiés avant toute
  lecture, `Cache-Control: private, no-store`.
- Garanties portées par la base :
  - un PDF n'est jamais supprimé ;
  - une révision ne se modifie ni ne se supprime ;
  - les révisions sont numérotées sans trou ;
  - la révision 1 est l'original ;
  - une signature porte toujours le nom du signataire et l'empreinte du tracé ;
  - aucune signature sur une version organisée ou biffée ;
  - un même contenu n'est créé qu'une fois par société ;
  - les tables ne peuvent pas être vidées (`TRUNCATE`).
- Chaque écriture est tracée dans `history_logs` (`entityType = 'StudioPdf'`).

### Limites techniques

| Limite | Valeur | Raison |
|---|---|---|
| Fichier importé | 4 Mo | corps de requête Vercel (4,5 Mo) |
| Version enregistrée | 4,4 Mo | réponse Vercel (4,5 Mo) : toute version doit rester téléchargeable |
| Pages | 300 | temps de traitement |
| Éléments posés par enregistrement | 100 | |
| Pages biffées par enregistrement | 8 | images de 2,8 Mo au plus en tout (en base64, environ 3,7 Mo de requête) |
| Versions par PDF | 50 | |

### Tests

```bash
npm run test:lot-g
```

```bash
TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres npm run test:studio-pdf:pg:disposable
```

Le second test exige une instance PostgreSQL **jetable** et locale. Le script refuse tout autre hôte.

### Incidents connus

| Symptôme | Cause | Action |
|---|---|---|
| `P2021 … studio_pdfs does not exist` | migrations non appliquées sur la base de production | `prisma migrate deploy` avec l'adresse de production |
| « Le PDF obtenu serait trop lourd » | version de plus de 4,4 Mo | travailler sur moins de pages (extraire d'abord) ou compresser le PDF avant import |
| « Ce PDF est protégé (chiffré) » | PDF chiffré | le déprotéger avec l'outil de l'émetteur, puis le réimporter |
| Recherche indisponible | PDF scanné sans couche texte | pas d'OCR dans l'espace PDF |
