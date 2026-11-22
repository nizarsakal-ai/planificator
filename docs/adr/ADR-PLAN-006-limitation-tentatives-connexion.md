# ADR-PLAN-006 — Limitation des tentatives de connexion et durée de session

| Champ | Valeur |
|-------|--------|
| **Statut** | **Proposé** — approche et seuils validés oralement par l'Autorité Architecture (Nizar, 23/11/2026, « Ok » après proposition) ; acceptation formelle et revue Codex en attente |
| **Date** | 2026-11-23 |
| **Décideur** | Autorité Architecture (Nizar) |
| **Revue** | Codex (Reviewer Indépendant) — à demander |
| **Norme** | ENGINEERING-STANDARD-001 §11, §13, §14, §21 ; PLAN-GOVERNANCE-001 |
| **SPEC** | [SPEC-AUTH-LOGIN-001](../specs/auth/SPEC-AUTH-LOGIN-001.md) |

## Contexte

Audit de sécurité du 23/11/2026 (référentiel « Sécuriser son appli », points 07 et 08). Faits vérifiés dans le dépôt (`main` @ 743c5ec) :

1. `authorize()` (`src/auth.ts`) enchaîne recherche de l'utilisateur puis `bcrypt.compare` **sans aucune limite de tentatives**. Le formulaire (`LoginForm`) et l'inscription (`/inscription`) appellent `signIn("credentials")`, donc la route Auth.js `/api/auth/callback/credentials` est exposée au brute force et au credential stuffing.
2. `authConfig.session` est `{ strategy: "jwt" }` sans `maxAge` : durée par défaut d'Auth.js (30 jours), identique pour tous les rôles.
3. Le callback `jwt` (Node) relit déjà l'utilisateur et renvoie `null` si `user.active` est faux ou si l'accès entreprise a disparu : la révocation d'un compte désactivé **est déjà effective** à chaque lecture de session côté Node. Ce point n'est donc **pas** à traiter.
4. Vercel est serverless : un compteur en mémoire n'est pas partagé entre instances. Le dépôt applique déjà le principe « compteurs lus en base » (`docs/runbooks/INTEGRATION-RATE-LIMITS.md`).
5. Écart connu : quand l'utilisateur n'existe pas, `authorize()` répond sans exécuter `bcrypt.compare` ; la différence de durée permet d'énumérer des adresses.

## Décision

1. **Compteur de tentatives en base Postgres (Neon)**, table dédiée `LoginAttempt`, plutôt qu'un service externe (Upstash/Redis). Aucun nouveau fournisseur, aucune nouvelle dépendance, aucun nouveau secret ; volume faible (une ligne par tentative).
2. **Identifiants jamais stockés en clair** : l'adresse et l'IP sont enregistrées sous forme d'empreinte HMAC-SHA256 avec un secret serveur dédié. La table ne permet ni de lister des adresses ni de les retrouver sans le secret.
3. **Règle** : 5 échecs en 15 minutes pour une même adresse ⇒ verrouillage de cette adresse jusqu'à 15 minutes après le dernier échec ; 20 échecs en 15 minutes pour une même IP (toutes adresses confondues) ⇒ verrouillage de l'IP selon la même durée. Un succès remet à zéro le décompte de l'adresse.
4. **Verrou temporaire, jamais définitif**, et pas de désactivation du compte : un tiers ne doit pas pouvoir bloquer durablement un utilisateur.
5. **Réponse indistinguable** : pendant un verrouillage, `authorize()` retourne `null` sans exécuter `bcrypt.compare`, avec le même message générique qu'un mot de passe erroné. Motif `RATE_LIMITED` ajouté au journal serveur (`logLoginRefusal`), sans adresse ni IP.
6. **Égalisation du temps de réponse** pour l'utilisateur inconnu (comparaison factice contre un hash fixe) afin de fermer l'énumération par le temps (fait 5).
7. **Durée de session** : Auth.js ne propose pas de `maxAge` par rôle. Décision : `maxAge` global de 14 jours (au lieu de 30), et **âge absolu maximal de 8 heures pour SUPER_ADMIN et ADMIN**, contrôlé dans le callback `jwt` (Node) à partir de la date d'émission du jeton. Les rôles de terrain (équipiers, chefs d'équipe) gardent la session longue, indispensable sur mobile/Capacitor.
8. **Purge** des lignes de plus de 30 jours.

## Conséquences

- Une migration de schéma (table `LoginAttempt`, index `(emailHash, createdAt)` et `(ipHash, createdAt)`), appliquée par `neondb_owner` selon `docs/runbooks/DB-APP-ROLE.md` ; script de retour arrière SQL à fournir avant application.
- Une variable d'environnement secrète à créer côté Vercel : clé HMAC de l'empreinte (≥ 32 octets aléatoires). Sa rotation invalide les compteurs en cours, sans autre effet.
- Une écriture et deux lectures indexées par tentative : latence négligeable devant `bcrypt`.
- Course possible entre tentatives simultanées : le seuil peut être dépassé de quelques unités. Accepté, car borné par la concurrence réelle d'un même attaquant et sans effet sur la sécurité du mot de passe.
- Risque résiduel de déni de service ciblé (un tiers peut verrouiller une adresse 15 minutes en la saisissant 5 fois). Accepté ; atténué par la durée courte, le couplage à l'IP et l'absence de blocage définitif.
- Utilisateurs derrière une IP partagée (bureau, 4G d'opérateur) : le seuil IP à 20 échecs reste large pour limiter les faux positifs.
- Les administrateurs devront se reconnecter au plus toutes les 8 heures.
- Ne couvre pas : réinitialisation de mot de passe, inscription publique, 2FA. À traiter par ADR séparés.

## Alternatives considérées

| Option | Raison du rejet |
|---|---|
| Upstash / Redis | Fournisseur, secret et dépendance supplémentaires pour un volume qui ne le justifie pas ; latence réseau supplémentaire. Reste l'option de repli si la charge devient significative. |
| Compteur en mémoire de l'instance | Inefficace en serverless (instances multiples, démarrages à froid). |
| Limite Vercel Firewall / WAF seule | Ne distingue pas les adresses saisies ; dépend du plan ; non versionnée dans le code. Peut compléter, pas remplacer. |
| Désactivation du compte après N échecs | Permet à un tiers de verrouiller un utilisateur à volonté. |
| Verrouillage par IP seule | Contournable par rotation d'IP ; pénalise les réseaux partagés. |
| `maxAge` global court (8 h) | Dégrade l'usage terrain mobile. |
| Passage à des sessions en base (`strategy: "database"`) | Changement d'architecture majeur, incompatible avec le middleware Edge actuel. |

## Références SPEC / TASK

- [SPEC-AUTH-LOGIN-001](../specs/auth/SPEC-AUTH-LOGIN-001.md) (proposée avec cet ADR).
