# SPEC-AUTH-LOGIN-001 — Limitation des tentatives de connexion et durée de session

| Champ | Valeur |
|-------|--------|
| **Statut** | **Proposée** — implémentation non autorisée tant que l'ADR n'est pas accepté et la revue Codex rendue |
| **ADR** | [ADR-PLAN-006](../../adr/ADR-PLAN-006-limitation-tentatives-connexion.md) |
| **Norme** | ENGINEERING-STANDARD-001 ; PLAN-GOVERNANCE-001 |

## 1. Périmètre

Dedans : `authorize()` du fournisseur Credentials (`src/auth.ts`), durée de session (`src/auth.config.ts`, callback `jwt`), table de compteurs, purge.
Dehors : réinitialisation de mot de passe, inscription publique, 2FA, WAF.

## 2. Modèle de données

Table `login_attempts` (Prisma `LoginAttempt`) :

| Colonne | Type | Remarque |
|---|---|---|
| `id` | cuid | clé |
| `emailKey` | text | HMAC-SHA256(secret, email normalisé en minuscules), hex |
| `ipKey` | text | HMAC-SHA256(secret, IP), hex ; vide si IP absente |
| `success` | boolean | |
| `createdAt` | timestamptz | défaut `now()` |

Index : `(emailKey, createdAt)`, `(ipKey, createdAt)`. Aucune clé étrangère (aucun lien à `users`, aucune donnée en clair). Le rôle applicatif `planificator_app` reçoit uniquement `SELECT, INSERT, DELETE`.

## 3. Algorithme (dans `authorize(credentials, request)`)

1. Valider les entrées (schéma Zod existant) ; en cas d'échec : refus `INVALID_INPUT`, compté comme échec sur l'IP seulement.
2. Calculer `emailKey` et `ipKey`. IP = premier élément de `x-forwarded-for` fourni par Vercel ; absente ⇒ `ipKey` vide et seul le seuil par adresse s'applique.
3. Lire : `failuresEmail` = échecs de `emailKey` depuis `max(15 min, dernier succès)` ; `failuresIp` = échecs de `ipKey` sur 15 min ; `lastFailure` correspondant.
4. Si `failuresEmail ≥ 5` ou `failuresIp ≥ 20` et `now < lastFailure + 15 min` ⇒ **refus `RATE_LIMITED`** : retourner `null`, **sans** `bcrypt.compare` ni lecture de l'utilisateur, sans insérer de ligne (le verrou ne se prolonge pas de lui-même).
5. Sinon exécuter la logique actuelle. Utilisateur inconnu ou inactif : `bcrypt.compare` factice contre un hash constant de même coût, puis refus.
6. Insérer une ligne `success` ou échec (`emailKey`, `ipKey`).
7. Toute erreur d'accès à la table ⇒ refus de la connexion (échec fermé), journalisé `RATE_LIMIT_STORE_ERROR`.

Constantes dans un seul module (`src/lib/auth/login-throttle.ts`), sans variable d'environnement : `EMAIL_MAX_FAILURES = 5`, `IP_MAX_FAILURES = 20`, `WINDOW_MS = 15 min`, `RETENTION_DAYS = 30`. Seul secret : `LOGIN_THROTTLE_HMAC_KEY` (≥ 32 octets) ; absent ⇒ la connexion échoue fermée au démarrage de l'appel, jamais de repli en clair.

## 4. Session

- `session.maxAge = 14 jours` (`authConfig`), `updateAge` inchangé.
- Callback `jwt` (Node) : pour `SUPER_ADMIN` et `ADMIN`, si `now − token.iat > 8 h` ⇒ retourner `null` (reconnexion). Autres rôles : inchangé.
- À vérifier en test (point ouvert) : le middleware Edge n'a pas Prisma et n'exécute pas ce contrôle ; les pages et API protégées appellent `auth()` côté Node. Le test doit prouver qu'un jeton admin de plus de 8 h est refusé sur une page protégée et sur une route API, sinon la spec est à réviser.

## 5. Journal et confidentialité

`logLoginRefusal` reçoit `RATE_LIMITED` et `RATE_LIMIT_STORE_ERROR` : jamais d'adresse, d'IP, d'empreinte ni de valeur saisie dans les journaux. Le message affiché reste l'actuel message générique.

## 6. Purge

Suppression des lignes de plus de 30 jours dans un cron quotidien existant du même type que `connector-retention` (décision : réutiliser ce cron ou en ajouter un — **question ouverte Q1**).

## 7. Tests exigés

- Unitaires : seuils (4 échecs ok, 5 verrouille), fenêtre glissante, remise à zéro après succès, IP vs adresse, IP absente, empreinte stable, aucune écriture pendant le verrou, échec fermé si la table est indisponible, clé HMAC absente.
- Non-régression : un mot de passe correct est refusé pendant un verrou ; le même message est renvoyé verrou ou non ; pas de `bcrypt.compare` pendant un verrou.
- Timing : utilisateur inconnu et mot de passe erroné exécutent tous deux un `bcrypt.compare`.
- Session : jeton admin de 7 h 59 accepté, de 8 h 01 refusé (page et API) ; jeton équipier de 3 jours accepté.
- PostgreSQL réel (`*.pg.test.ts`) : index utilisés, rôle applicatif sans droits DDL, purge.

## 8. Livraison

1. Migration SQL + retour arrière, appliquées par `neondb_owner` hors Vercel ; table vide au départ, sans effet tant que le code n'est pas déployé.
2. Secret HMAC créé dans Vercel (preview puis production).
3. Code déployé en preview, test manuel de verrouillage, puis production.
4. Retour arrière : redéployer le commit précédent ; la table peut rester sans effet.

## 9. Décisions ouvertes à trancher par l'Autorité

- **Q1** : purge dans le cron `connector-retention` ou cron dédié.
- **Q2** : accepter l'âge absolu de 8 h pour SUPER_ADMIN/ADMIN, ou le porter à 12 h.
- **Q3** : accepter le seuil IP à 20 échecs, ou le relever si des équipes partagent une même IP de chantier.
