# Sécurité — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : exigences de sécurité (normatives pour l'implémentation de la spec) ; décisions de rôles = **D4**.

1. `companyId` **uniquement** de la session ; jamais du corps ni de l'URL. Compte sans entreprise → `NO_COMPANY`.
2. **Chaque** requête (Prisma et SQL brut) filtre `companyId` : véhicule, trajet, chantier, chauffeur.
3. Un `truckId` / `tripId` / `worksiteId` / `chauffeurId` d'une autre entreprise est **introuvable** (404), jamais « interdit » (pas de fuite d'existence).
4. Ordre des contrôles : 401 → 403 rôle → 403 `NO_COMPANY` → validation → accès base.
5. Rôles : constantes exportées et testées (modèle `TRUCKS_*_ROLES`). **Ne pas reproduire** l'écart TEAM_LEADER de V0–V1C sans décision explicite (D4).
6. Kilométrage = donnée opérationnelle, pas de donnée personnelle directe ; mais un trajet lie un **chauffeur** à des déplacements : traiter comme donnée personnelle (accès limité, pas dans les logs). **À AUDITER** (RGPD).
7. Logs : codes et identifiants seulement, jamais de contenu de requête brut.
8. Aucun secret ni `.env*` impliqué.
9. Test obligatoire : l'entreprise B ne peut ni lire, ni créer, ni modifier un trajet de l'entreprise A, ni référencer son chantier/chauffeur.
