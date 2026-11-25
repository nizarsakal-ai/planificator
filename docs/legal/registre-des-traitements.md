# Registre des activités de traitement (RGPD art. 30)

*Brouillon du 25/11/2026, établi à partir du code de Planificator. À relire par un juriste et à tenir à jour à chaque nouvelle fonction.*

Il y a deux registres :
- **Partie A**, pour chaque société qui utilise Planificator avec ses propres salariés (par exemple les sociétés de Nizar). Elle est **responsable** des traitements. Une copie doit être tenue par société.
- **Partie B**, pour l'Éditeur, en tant que **sous-traitant** des sociétés extérieures (art. 30.2).

**Responsable :** [À COMPLÉTER : raison sociale, adresse, SIREN, représentant légal]
**Contact données personnelles :** [À COMPLÉTER]
**DPO :** [À COMPLÉTER : nom, ou « non désigné »]

Les durées marquées « *proposée* » sont à valider avec le juriste.

---

## Partie A : traitements dont la société est responsable

### A1. Gestion des comptes et des accès
- **Finalité :** donner accès à l'application selon le rôle.
- **Base légale :** exécution du contrat de travail ou du contrat commercial ; intérêt légitime (sécurité).
- **Personnes :** salariés, dirigeants, clients ayant un espace client.
- **Données :** nom, e-mail, empreinte du mot de passe, rôle, société, invitations, demandes de réinitialisation, journaux de connexion.
- **Destinataires :** administrateurs de la société ; prestataires techniques (annexe).
- **Durée :** compte actif, puis 30 jours ; journaux 1 an.
- **Transferts hors UE :** voir l'annexe.
- **Sécurité :** voir l'annexe sécurité du DPA.

### A2. Planning des chantiers, équipes, matériel
- **Finalité :** organiser les interventions.
- **Base légale :** intérêt légitime ; exécution du contrat de travail.
- **Personnes :** salariés, chefs d'équipe, clients (adresse du chantier).
- **Données :** nom, poste, téléphone, photo, équipes, affectations, chantiers, réservations de matériel, logements des équipes, tâches.
- **Destinataires :** encadrement, salariés concernés, assistant IA (si accord).
- **Durée :** *proposée* 3 ans après la fin du chantier.

### A3. Pointage des heures avec position
- **Finalité :** décompter le temps de travail ; prouver la présence sur le chantier.
- **Base légale :** obligation légale (Code du travail L3171-2 et suivants) ; intérêt légitime.
- **Personnes :** salariés.
- **Données :** heures d'arrivée et de départ, chantier, **position GPS au seul instant du pointage** (pas de suivi en continu), commentaire.
- **Destinataires :** encadrement, service paie, inspection du travail sur demande.
- **Durée :** position **2 mois** (recommandation CNIL), heures 5 ans. ⚠️ L'effacement automatique des positions est à développer (lot 2).
- **Préalables :** information individuelle des salariés (note fournie) ; consultation du CSE s'il existe (Code du travail L2312-38). AIPD conseillée.

### A4. Absences et congés
- **Finalité :** gérer les absences et les congés.
- **Base légale :** exécution du contrat de travail ; obligation légale.
- **Personnes :** salariés.
- **Données :** type, dates, statut, motif facultatif (sans diagnostic médical), commentaire de refus.
- **Destinataires :** encadrement, paie. Le motif n'est jamais transmis à l'assistant IA.
- **Durée :** 5 ans.

### A5. Notes de frais et tickets de carburant
- **Finalité :** rembourser les frais ; tenir la comptabilité.
- **Base légale :** exécution du contrat de travail ; obligation légale comptable.
- **Personnes :** salariés.
- **Données :** montant, date, catégorie, description, photo du justificatif, validation.
- **Destinataires :** encadrement, comptabilité, expert-comptable.
- **Durée :** 10 ans (Code de commerce L123-22).

### A6. Documents RH et pré-paie
- **Finalité :** remettre les documents RH aux salariés ; préparer la paie ; vérifier le droit au travail.
- **Base légale :** obligation légale ; exécution du contrat de travail.
- **Personnes :** salariés, nouveaux embauchés.
- **Données :** bulletins, contrats, attestations, pièce d'identité ou titre de travail (lecture automatique de la bande MRZ pour préremplir la fiche), variables de paie, accusés de lecture, messages RH, journal des consultations.
- **Destinataires :** service RH, salarié concerné, expert-comptable ou prestataire de paie. Fichiers stockés sur le Google Drive de la société.
- **Durée :** bulletins 5 ans (L3243-4) ; titres de travail : durée du contrat (*proposée*, à vérifier) ; autres documents : durée du contrat + 5 ans (*proposée*).
- **Remarque :** données à risque (identité). Accès restreint et tracé. AIPD conseillée.

### A7. Véhicules, tournées, kilométrage
- **Finalité :** gérer la flotte, l'entretien, les documents obligatoires et les coûts.
- **Base légale :** intérêt légitime ; obligation légale (assurance, contrôle technique).
- **Personnes :** conducteurs.
- **Données :** conducteur, véhicule, relevés kilométriques, tournées et arrêts, dépenses, documents du véhicule, rappels.
- **Destinataires :** encadrement, comptabilité.
- **Durée :** *proposée* 1 an pour les tournées (CNIL : optimisation des tournées) ; 10 ans pour les dépenses (pièces comptables).
- **Remarque :** pas de géolocalisation continue des véhicules.

### A8. Photos de chantier et réserves
- **Finalité :** suivre et prouver les travaux ; lever les réserves.
- **Base légale :** intérêt légitime.
- **Personnes :** salariés (auteurs) ; éventuellement des personnes visibles sur les photos.
- **Données :** photos, date, chantier, auteur, destinataires des envois.
- **Destinataires :** encadrement, client du chantier si partage ; stockage Cloudinary ou Google Drive.
- **Durée :** *proposée* 10 ans après réception des travaux (garantie décennale).

### A9. Clients, devis, factures, comptabilité, banque
- **Finalité :** gestion commerciale, facturation, recouvrement, comptabilité, TVA.
- **Base légale :** exécution du contrat ; obligation légale.
- **Personnes :** clients, contacts, fournisseurs.
- **Données :** identité, coordonnées, SIREN/TVA, devis, factures, paiements, relances, signature électronique des devis, factures fournisseurs (lecture automatique), relevés bancaires, écritures.
- **Destinataires :** comptabilité, expert-comptable, administration fiscale ; envoi des e-mails par Resend ; lecture automatique par Anthropic (si accord).
- **Durée :** 10 ans.

### A10. Espace client
- **Finalité :** permettre au client de suivre ses chantiers et documents.
- **Base légale :** exécution du contrat.
- **Personnes :** clients.
- **Données :** nom, e-mail, chantiers, documents partagés.
- **Durée :** durée de la relation commerciale + 3 ans (*proposée*).

### A11. Import des demandes reçues par e-mail (consultations, réservations)
- **Finalité :** transformer les demandes de partenaires en chantiers ou en réservations.
- **Base légale :** intérêt légitime.
- **Personnes :** expéditeurs (partenaires, clients), personnes citées dans les e-mails.
- **Données :** expéditeur, objet, contenu, pièces jointes, journal des décisions.
- **Destinataires :** équipe commerciale ; Google (boîte Gmail de la société) ; Anthropic pour l'extraction (si accord).
- **Durée :** *proposée* 12 mois pour les e-mails non convertis ; ensuite selon A2 ou A9.
- **Remarque :** l'accès Gmail en lecture exige une vérification Google et un audit de sécurité annuel (CASA) si le service est ouvert à d'autres sociétés.

### A12. Assistant d'intelligence artificielle
- **Finalité :** répondre aux questions, résumer, proposer des actions.
- **Base légale :** intérêt légitime ; **accord préalable de l'utilisateur** (exigence Apple 5.1.2).
- **Personnes :** utilisateurs ; personnes citées dans les données consultées.
- **Données :** questions posées, données de planning et de gestion utiles à la réponse (jamais les motifs d'absence), propositions et journal des actions.
- **Destinataires :** Anthropic (États-Unis).
- **Durée :** *proposée* 1 an pour le journal ; chez Anthropic : [À VÉRIFIER].
- **Remarque :** toute proposition est validée par une personne (pas de décision automatisée, art. 22).

### A13. Prospection, opportunités, marketing
- **Finalité :** trouver et suivre des clients ; mesurer les campagnes.
- **Base légale :** intérêt légitime (prospection entre professionnels) ; consentement pour les envois marketing.
- **Personnes :** prospects professionnels.
- **Données :** entreprise, contact professionnel, historique, consentements ; avis de marchés publics (BOAMP, données publiques).
- **Durée :** 3 ans après le dernier contact (recommandation CNIL).

### A14. Sécurité et journaux
- **Finalité :** sécuriser le service ; tracer les accès sensibles.
- **Base légale :** intérêt légitime ; obligation de sécurité (art. 32).
- **Données :** historique des modifications, journaux d'accès aux documents et pièces jointes, journaux d'accès automatisés, adresse IP.
- **Durée :** 1 an (*proposée*, conforme aux recommandations CNIL sur la journalisation).

---

## Partie B : registre de l'Éditeur, sous-traitant (art. 30.2)

- **Sous-traitant :** [À COMPLÉTER : Éditeur]
- **Responsables pour le compte desquels il agit :** chaque société cliente inscrite. La liste est tenue dans l'espace super-administrateur.
- **Catégories de traitements :** A1 à A14 ci-dessus, effectués pour le compte des clients.
- **Sous-traitants ultérieurs et transferts :** annexe ci-dessous.
- **Mesures de sécurité :** annexe 1 de l'[accord de sous-traitance](accord-sous-traitance-dpa.md).

L'Éditeur est aussi **responsable** d'un traitement propre : la gestion des comptes de ses sociétés clientes (inscription, contact, facturation du service). Données : nom, e-mail et fonction de l'administrateur, société. Durée : relation commerciale + 3 ans.

---

## Annexe : prestataires et transferts

| Prestataire | Rôle | Données concernées | Lieu | Garantie de transfert | DPA signé ? |
|---|---|---|---|---|---|
| Vercel Inc. | Hébergement | Toutes (en transit) | Francfort ; société US | [À VÉRIFIER] | [ ] |
| Neon Inc. | Base de données | Toutes | Francfort (AWS eu-central-1) ; société US | [À VÉRIFIER] | [ ] |
| Cloudinary | Fichiers | Photos, justificatifs, pièces jointes, logos | [À VÉRIFIER] | [À VÉRIFIER] | [ ] |
| Anthropic PBC | IA | A9, A11, A12 | États-Unis | [À VÉRIFIER] | [ ] |
| Resend | E-mails | Destinataires et contenu des e-mails envoyés | [À VÉRIFIER] | [À VÉRIFIER] | [ ] |
| Google | Gmail, Agenda, Drive | A6, A8, A11 | Selon contrat Google Workspace | Contrat Google | [ ] |
| Fondation OpenStreetMap | Cartes, géocodage | Adresse IP, adresses recherchées | Royaume-Uni | Adéquation | n/a (service public) |
