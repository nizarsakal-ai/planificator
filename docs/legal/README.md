# Dossier juridique de Planificator (lot 1) : brouillons

**Statut : brouillons à relire par un juriste ou un avocat avant toute mise en ligne.**
Ces textes décrivent ce que fait l'application au 25/11/2026. Ils ont été écrits à partir du code. Ils ne sont pas encore publiés et ne remplacent pas un conseil juridique.

## Les documents

| Fichier | À quoi il sert | Où il ira |
|---|---|---|
| [mentions-legales.md](mentions-legales.md) | Identifier l'éditeur et l'hébergeur (loi LCEN n° 2004-575) | Page publique `/mentions-legales` (lot 2) |
| [politique-de-confidentialite.md](politique-de-confidentialite.md) | Informer toutes les personnes dont l'appli traite les données (RGPD art. 13 et 14) | Page publique `/confidentialite`, lien dans l'appli et dans les fiches des stores |
| [cgu.md](cgu.md) | Contrat d'utilisation entre l'éditeur et chaque société cliente | Page `/cgu` + case « J'accepte » à l'inscription |
| [accord-sous-traitance-dpa.md](accord-sous-traitance-dpa.md) | Contrat RGPD obligatoire (art. 28) quand une société extérieure utilise l'appli | Annexe des CGU |
| [registre-des-traitements.md](registre-des-traitements.md) | Registre obligatoire (RGPD art. 30) | Interne, à garder à jour, à montrer à la CNIL sur demande |
| [note-information-salaries-pointage.md](note-information-salaries-pointage.md) | Informer les salariés du pointage avec position (Code du travail L1222-4, CNIL) | À remettre aux salariés, à afficher, à présenter au CSE s'il existe |

## Ce que Nizar doit fournir (repéré par « [À COMPLÉTER] »)

1. Pour chaque société concernée : raison sociale exacte, forme (SARL, SAS…), capital, SIREN/RCS et ville du greffe, adresse du siège, numéro de TVA.
2. Nom du directeur de la publication (en général le gérant ou le président).
3. Une adresse e-mail de contact pour les questions de données personnelles (par exemple `rgpd@galyaevents.fr`) et un téléphone.
4. L'éditeur du service : quelle société « vend » ou met à disposition Planificator aux autres sociétés ?
5. Le prix du service, s'il est payant (sinon les CGU disent « gratuit pour l'instant »).
6. La ville du tribunal compétent (en général celle du siège).
7. Y a-t-il un CSE dans chacune des sociétés qui utilisent le pointage ?

## Fournisseurs : vérifiés le 25/11/2026 (détail dans les notes partagées)

Les textes reprennent ces vérifications. Il reste quatre actions :
- **Cloudinary** : les fichiers sont stockés aux États-Unis (l'Europe n'est possible qu'en offre Enterprise). Il faut confirmer avec Cloudinary que son contrat RGPD couvre un compte sans bon de commande.
- **Google** : vérifier dans la console d'administration Google que l'avenant de traitement des données (CDPA) est accepté. Le cocontractant est Google Cloud France.
- **Resend** : sa certification DPF est en cours de renouvellement ; à revérifier.
- **Neon** : la restauration de la base n'est gardée que 1 jour par défaut sur les offres payantes (7 jours en Launch, 30 jours en Scale) ; vérifier l'offre souscrite.

Anthropic n'est pas certifié DPF : le transfert repose sur les clauses contractuelles types de son contrat, ce qui est valable.

## Ce que ces textes engagent pour le lot 2 (code)

Les textes promettent certaines choses ; l'appli devra les faire avant la mise en ligne :

- Effacer automatiquement les coordonnées GPS des pointages au bout de **2 mois**, en gardant les heures. Le registre et la note salariés l'annoncent ; aucune purge n'existe aujourd'hui.
- Afficher un écran d'information et recueillir l'accord avant d'utiliser l'assistant IA (exigence Apple 5.1.2).
- Permettre à chaque société de désactiver les fonctions d'IA (le DPA le promet).
- ~~Proposer la suppression du compte et l'export des données~~ : fait au lot 2b (Mon profil, page `/suppression-compte`). Reste à prévoir l'export des données d'une société pendant 30 jours après la fermeture de son espace.
- Configurer la variable `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL` sur Vercel : sans elle, la page de suppression affiche « Adresse de contact en cours de configuration ».
- ~~Ajouter la case d'acceptation des CGU à l'inscription, et les liens vers les pages légales~~ : fait au lot 2a.
- ~~Retirer de l'appli iOS la demande de position « toujours »~~ : fait au lot 2a.

## Points à trancher avec le juriste

- **Rôle de l'éditeur :** pour ses propres salariés, chaque société est responsable du traitement. Pour les sociétés extérieures, l'éditeur est sous-traitant. Les textes suivent ce schéma ; il faut le confirmer.
- **Analyse d'impact (AIPD) :** elle est conseillée vu le pointage avec position, les documents RH (dont les pièces d'identité) et l'IA. Il faut décider si elle est obligatoire.
- **Durées de conservation proposées :** elles sont indiquées comme propositions dans le registre.
