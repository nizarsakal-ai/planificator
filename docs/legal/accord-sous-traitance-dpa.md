# Accord de sous-traitance des données personnelles (annexe aux CGU)

*Brouillon du 25/11/2026, à relire par un juriste. Base : article 28 du RGPD.*

**Entre :**
- le Client, société qui utilise Planificator, **responsable du traitement** ;
- et l'Éditeur, [À COMPLÉTER : raison sociale, siège, SIREN], **sous-traitant**.

## 1. Objet

L'Éditeur traite des données personnelles pour le compte du Client, dans le seul but de lui fournir le service Planificator décrit dans les CGU.

## 2. Description du traitement

| Élément | Contenu |
|---|---|
| Nature des opérations | Hébergement, stockage, consultation, organisation, calcul, envoi d'e-mails, lecture automatique de documents et d'e-mails, effacement |
| Finalités | Planning, pointage, absences, notes de frais, documents RH et pré-paie, véhicules, photos de chantier, devis, facturation, comptabilité, espace client, import des demandes reçues par e-mail, assistant IA, prospection entre professionnels |
| Personnes concernées | Salariés et dirigeants du Client ; clients, contacts, fournisseurs et prospects du Client ; expéditeurs des e-mails importés |
| Données | Identité, coordonnées professionnelles, poste, affectations, heures et position au pointage, absences, frais et justificatifs, documents RH (dont pièces d'identité ou titres de travail), variables de paie, données de véhicules et de tournées, photos, données commerciales et comptables, contenu d'e-mails, journaux de connexion |
| Données sensibles | Aucune prévue. Le Client s'engage à ne pas saisir de données de santé. |
| Durée | Durée du contrat, puis effacement selon l'article 9 |

## 3. Engagements de l'Éditeur

L'Éditeur s'engage à :

1. ne traiter les données que sur **instruction documentée** du Client. Les CGU, le paramétrage de l'application et les actions des Utilisateurs valent instructions. Il prévient le Client si une instruction lui paraît contraire au RGPD ;
2. ne pas utiliser les données pour son propre compte. En particulier, il ne les vend pas et ne s'en sert pas pour de la publicité ;
3. veiller à ce que les personnes autorisées à accéder aux données soient tenues à la **confidentialité** ;
4. mettre en œuvre les **mesures de sécurité** décrites en annexe 1 ;
5. aider le Client à répondre aux **demandes des personnes** (accès, rectification, effacement, portabilité, opposition), dans la mesure du possible par des fonctions de l'application. Il lui transmet sans délai toute demande reçue directement ;
6. notifier au Client toute **violation de données** dans les **48 heures** après en avoir eu connaissance. Il fournit les éléments utiles à la notification de la CNIL (RGPD art. 33) ;
7. aider le Client pour ses **analyses d'impact** (AIPD) et la consultation préalable de la CNIL, si elles sont nécessaires ;
8. tenir un **registre** des traitements effectués pour le compte de ses clients (RGPD art. 30.2) ;
9. mettre à disposition du Client les informations nécessaires pour démontrer le respect de ces engagements. Il accepte un **audit** une fois par an au plus, à la charge du Client, avec un préavis de 30 jours, réalisé par un auditeur tenu au secret.

## 4. Sous-traitants ultérieurs

Le Client autorise l'Éditeur à faire appel aux sous-traitants listés en annexe 2.

L'Éditeur informe le Client de tout ajout ou remplacement au moins 30 jours à l'avance, par un message dans l'application ou par e-mail. Le Client peut s'y opposer pour un motif légitime. À défaut d'accord, il peut résilier sans frais.

L'Éditeur impose à chaque sous-traitant les mêmes obligations de protection des données. Il reste responsable envers le Client de leurs manquements.

## 5. Transferts hors de l'Union européenne

Les données sont hébergées en Union européenne (Francfort).

Certains sous-traitants sont des sociétés établies hors UE, ou traitent des données hors UE (annexe 2). Ces transferts reposent sur une décision d'adéquation de la Commission européenne, dont le « Data Privacy Framework » UE–États-Unis pour les sociétés certifiées, ou à défaut sur des clauses contractuelles types de la Commission. [À VÉRIFIER : mécanisme exact pour chaque prestataire]

## 6. Intelligence artificielle

Les fonctions d'IA envoient au prestataire Anthropic les données nécessaires à la tâche demandée, et seulement après l'accord de l'Utilisateur dans l'application. Le Client peut désactiver ces fonctions pour sa société. [À VÉRIFIER : réglage à ajouter au lot 2 s'il n'existe pas]

[À VÉRIFIER : engagement d'Anthropic de ne pas entraîner ses modèles avec ces données, et durée de conservation chez Anthropic.]

## 7. Obligations du Client

Le Client s'engage à :
- informer les personnes concernées. Un modèle de note d'information des salariés sur le pointage est fourni ;
- disposer d'une base légale pour chaque traitement ;
- consulter son CSE quand la loi l'exige ;
- tenir son propre registre des traitements ;
- ne pas importer de données qu'il n'a pas le droit de traiter.

## 8. Responsabilité

Chaque partie répond de ses propres manquements au RGPD, dans les limites prévues par les CGU et par l'article 82 du RGPD.

## 9. Fin du contrat

À la fin du contrat :
- le Client peut exporter ses données pendant 30 jours ;
- l'Éditeur efface ensuite les données et leurs copies, y compris dans les sauvegardes au terme de leur cycle ([À VÉRIFIER : durée]), sauf obligation légale de conservation qui pèse sur l'Éditeur lui-même ;
- sur demande, l'Éditeur confirme l'effacement par écrit.

---

## Annexe 1 : mesures de sécurité

- **Chiffrement des échanges :** HTTPS (TLS) pour tous les accès.
- **Chiffrement au repos :** assuré par l'hébergeur de la base. [À VÉRIFIER : confirmation Neon]
- **Mots de passe :** jamais stockés en clair. Seule une empreinte irréversible est gardée (bcrypt).
- **Clés d'accès aux services connectés** (Gmail, Agenda, Drive…) : chiffrées en base avec une clé distincte de la base de données.
- **Séparation des sociétés :** chaque donnée est rattachée à une société. Les accès sont filtrés par société et par rôle.
- **Rôles :** administrateur, chef d'équipe, salarié, client. Accès limité au nécessaire.
- **Traçabilité :** historique des modifications et journal des consultations des documents RH, des pièces jointes et des accès automatisés.
- **Hébergement :** Union européenne (Francfort). Sauvegardes gérées par l'hébergeur.
- **Accès techniques :** les secrets de production ne sont pas manipulés en clair par les intervenants. Les modifications de production passent par une validation du dirigeant.
- [À COMPLÉTER : double authentification, si elle est ajoutée ; procédure de gestion des incidents]

## Annexe 2 : sous-traitants ultérieurs autorisés

| Sous-traitant | Service | Lieu des données | Base du transfert |
|---|---|---|---|
| Vercel Inc. (États-Unis) | Hébergement de l'application | Francfort (Allemagne) | [À VÉRIFIER] |
| Neon Inc. (États-Unis) | Base de données | Francfort (Allemagne) | [À VÉRIFIER] |
| Cloudinary (États-Unis) | Stockage de fichiers (photos, justificatifs, pièces jointes, logos) | [À VÉRIFIER] | [À VÉRIFIER] |
| Anthropic PBC (États-Unis) | Intelligence artificielle | États-Unis | [À VÉRIFIER] |
| Resend (États-Unis) | Envoi d'e-mails | [À VÉRIFIER] | [À VÉRIFIER] |
| Google (Irlande / États-Unis) | Gmail, Agenda, Drive, seulement si le Client les connecte à son propre compte Google | Selon le contrat Google du Client | Contrat Google du Client |
| Fondation OpenStreetMap (Royaume-Uni) | Fonds de carte et recherche d'adresses (adresse IP et adresse recherchée) | Royaume-Uni | Décision d'adéquation |
