# Planificateur V3 — périmètre intégré et preuves

Version opérationnelle publiée le 25 octobre 2026. Le runbook courant est `docs/vehicle-v3-release.md` ; les anciens états de préparation sont conservés dans `docs/archive/`. Les identifiants et résultats de l’audit courant figurent dans le rapport final daté, qui prévaut sur les anciens rapports de préparation.

## Fonctions intégrées

- Fiche camion : navigation Documents, Tournées, Carburant et coûts, Imports selon les droits effectifs.
- Documents : contrôle technique, réparations/entretien, carte grise, assurance et justificatifs de dépenses. Versions immuables, vérification explicite, archivage, émetteur/compagnie, référence/contrat, dates et kilométrage ; liaison aux interventions. Dates d’effet et d’échéance, documents futurs, documents manquants et notifications internes de rappel dédupliquées.
- Stockage privé Cloudinary : PDF/JPEG/PNG, 4 Mio maximum, historique et proxy privé. Autorisation avant et après récupération, empreinte et flux bornés. Les contrôles de contenu ne remplacent pas un antivirus.
- Dépenses : carburant, entretien, assurance et autres frais ; justificatifs et interventions du même camion/entreprise ; montants décimaux, corrections historisées, commandes idempotentes et protections SQL.
- Coûts : périodes et devises explicites, coûts affectés à un trajet séparés des totaux véhicule, absence de double comptabilisation, kilomètres réels corrigés du journal V2. Couverture et coût complets non présumés ; achats de carburant distingués de la consommation réelle.
- Tournées : étapes ordonnées, adresses confirmées, réservations des ressources, horaires du fuseau de l’entreprise et contrôle du changement d’heure. Départ et clôture atomiques avec le journal V2 ; aucune distance estimée n’alimente le compteur réel.
- Imports : source privée texte/PDF/photo, extraction déterministe ou OCR Anthropic avec consentement et budget borné, candidats non confirmés, correction et approbation explicites, consommation atomique par une tournée. Aucun chantier/tournée créé automatiquement par l’extraction.
- Géocodage : IGN/BAN, proposition explicite et cache partagé par société. Une coordonnée proposée doit être vérifiée avant confirmation.
- Routage : GraphHopper 11.1 privé sur le VPS, données OSM France métropolitaine. Points confirmés dans leur ordre ; départ/retour seulement s’ils sont inclus. Cache partagé par société/version du graphe, quota et admission atomiques, HTTPS et jeton serveur. Profil voiture avec restrictions de virage ; contraintes poids lourds non garanties et pas de trafic temps réel.

## Configuration et validation

Cloudinary, OCR, géocodage et routage ont chacun leurs gardes et leurs recettes réelles. Les rapports fournisseurs, les preuves d’interface et les rapports de publication sont distincts des simulations unitaires. Le cron quotidien de rappels utilise `CRON_SECRET` et crée des notifications internes, sans email/SMS automatique.

La base active comprend 62 migrations, dont huit ajouts V3/cartographie. Les sept migrations V3 initiales ne sont pas réécrites. La préproduction possède une base distincte explicitement gardée. La publication contrôle l’endpoint Neon d’origine, le registre actif des migrations et les contraintes, sans lancer de migration dans le build.

La source exacte publiée, son manifeste, les revues Claude via AI Team, les sorties de tests et les limites des vérifications sont regroupés dans le livrable final. Les anciennes mentions « prototype désactivé », « fournisseurs non exécutés » et les anciens nombres de tests restent des traces historiques, pas l’état courant.

L’audit final ajoute un résultat d’étape « Non visitée » avec motif, auteur et date, distinct d’une visite effectuée. Le compteur d’arrivée reste obligatoire ; les estimations n’alimentent jamais le kilométrage réel. Les paramètres de rappel utilisent une révision conditionnelle ; un même justificatif peut signaler un doublon potentiel, sans interdire une ventilation légitime.
