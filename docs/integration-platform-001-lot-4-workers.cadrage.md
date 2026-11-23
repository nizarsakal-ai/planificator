# LOT‑4 — Cadrage des workers Consultations

Le LOT‑4 introduit une façade de lecture du contenu et des pièces jointes. La première étape peut être réalisée sur données fictives. La validation de la première admission positive en production par le LOT‑3 reste ouverte.

## Point de départ

Le service de contenu et le service de téléchargement sélectionnent directement leurs adaptateurs Gmail. Les deux s’appuient sur la clé de boîte Acquisition du message. Le contrat `InboundArtifact` et le registre de capacités existent déjà côté plateforme.

## Première livraison proposée

1. Définir deux ports neutres pour la lecture du corps et des pièces. Conserver les limites, erreurs et politiques de reprise actuelles. Encapsuler les adaptateurs Gmail existants et leurs types dans la couche d’adaptation.
2. Résoudre la capacité à partir de la connexion d’intégration, de la société et de l’identité de boîte vérifiée. Préserver explicitement le cas historique où la clé de boîte est vide. Une référence de nouvelle admission introuvable ou provenant d’une autre société doit échouer avant toute lecture distante.
3. Relier les pièces existantes par leur identifiant, sans copier les binaires. Le domaine transmet une référence opaque. Seul l’adaptateur la traduit en identifiant Gmail. Retenir une évolution de schéma uniquement si les références persistées existantes ne suffisent pas.
4. Tester la parité sur PostgreSQL jetable et avec un fournisseur simulé. Couvrir la boîte historique, deux boîtes distinctes, le refus intersociété, les références manquantes, le contenu déjà présent et la reprise d’un téléchargement. Vérifier les sorties et les statuts, ainsi que l’absence de second téléchargement ou de copie physique.
5. Vérifier les frontières d’import. Les workers consomment les ports neutres. L’extraction, la revue, la conversion et Booking sortent du périmètre de modification.

## Point de décision

Avant de raccorder le résolveur aux workers, vérifier comment relier une admission LOT‑3 à sa connexion d’intégration. Aujourd’hui le message Acquisition garde la clé réelle de boîte. La recette doit distinguer ce lien du lien historique et prouver qu’un rattrapage choisit toujours la bonne boîte.

Références dans le dépôt — plan général §16, contrat `inbound-artifact.ts`, services `message-content.service.ts` et `attachment-download.service.ts`.

## Recette de la première étape

Les workers consomment des ports indépendants du fournisseur. Les adaptateurs Gmail historiques sont assemblés dans un module dédié. L’injection historique du fournisseur de pièces reste compatible. La résolution par capacité de connexion et le raccordement à la façade `InboundArtifact` restent à réaliser.

La recette sur PostgreSQL 17 jetable a appliqué 117 migrations existantes. Les 45 tests ciblés ont réussi, sans test ignoré. Les fournisseurs de contenu et de pièces ainsi que le stockage étaient simulés. Les tests ont vérifié la normalisation et la persistance du corps, la boîte transmise aux deux ports, le stockage et le hachage de la pièce, l’isolation par société, la concurrence et l’absence de nouvelle lecture si la pièce est déjà stockée.
