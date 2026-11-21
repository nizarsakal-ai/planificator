# Runbook — clés maîtres (KEK) du coffre à secrets PLATFORM_ENCRYPTED

Ce runbook concerne le PLAN-INTEGRATION-PLATFORM-001, LOT-8A. Il applique la SECURITY-SPEC (§6) et le plan `docs/integration-platform-001-lot-8-secret-provider-live-connectors.plan.md`.

## Ce que fait la KEK

Le coffre ne stocke en base que des secrets chiffrés, chacun par sa propre clé (DEK), elle-même enveloppée par une **KEK** conservée hors de la base. Sans la KEK, la base ne permet de déchiffrer aucun secret.

## Variables d'environnement (serveur uniquement)

| Variable | Valeur |
|---|---|
| `INTEGRATION_KEK_ACTIVE_ID` | identifiant de la KEK active : minuscules, chiffres ou `_`, au plus 32 caractères. Exemple : `k2026a` |
| `INTEGRATION_KEK_<ID>` | la KEK, en base64 de **32 octets** exactement. Exemple : `INTEGRATION_KEK_K2026A` |

Règles :

- **Production et Preview** reçoivent chacune leur **propre** KEK, jamais la même (§6.1, §16).
- La KEK ne doit jamais être égale à `GMAIL_TOKEN_ENCRYPTION_KEY`.
- Aucune KEK dans le dépôt, dans un fichier `.env` versionné, dans une capture d'écran ou dans une conversation.
- Si la configuration est absente ou incohérente, le coffre refuse de fonctionner (`SECURITY_CONFIGURATION_INVALID`). Il n'existe aucun mode dégradé.

## 1. Générer une KEK

Sur ton Mac, une fois par environnement :

```bash
openssl rand -base64 32
```

La commande affiche 44 caractères terminés par `=`. Copie-les directement dans Vercel, sans les enregistrer ailleurs.

## 2. Poser les KEK dans Vercel

Va dans Vercel, projet **planificator**, puis Settings → Environment Variables.

1. Ajoute `INTEGRATION_KEK_ACTIVE_ID` = `k2026a`, pour **Production** et **Preview**.
2. Ajoute `INTEGRATION_KEK_K2026A` = la première clé générée, pour **Production** seulement, en type *Sensitive*.
3. Génère une **seconde** clé.
4. Ajoute `INTEGRATION_KEK_K2026A` = cette seconde clé, pour **Preview** seulement, en type *Sensitive*.
5. Relance le dernier déploiement pour que les variables soient prises en compte.

## 3. Rotation d'une KEK (§6.2)

1. Génère une nouvelle clé et ajoute-la sous un nouvel identifiant, par exemple `INTEGRATION_KEK_K2027A`. **Ne retire pas** l'ancienne.
2. Passe `INTEGRATION_KEK_ACTIVE_ID` à `k2027a`, puis redéploie. Les nouveaux secrets sont alors enveloppés avec la nouvelle clé, et les anciens restent lisibles.
3. Réenveloppe les DEK existantes avec `rewrapCredentialDeks`, société par société. Les secrets ne sont pas rechiffrés.
4. Vérifie qu'aucune version `ACTIVE` ou `PENDING` n'utilise encore l'ancien `keyId` :

   ```sql
   SELECT "keyId", status, count(*) FROM integration_credential_versions GROUP BY 1, 2;
   ```

5. Retire l'ancienne variable seulement après cette preuve. Il est **interdit** de retirer une KEK dont dépend encore une version active.

## 4. Compromission d'une KEK (§6.3)

1. Désactive les connexions concernées : aucun nouveau run.
2. Applique les étapes de rotation ci-dessus avec une nouvelle clé.
3. Révoque et renouvelle chez chaque fournisseur les secrets externes stockés (clés d'API, jetons).
4. Audite l'incident.
