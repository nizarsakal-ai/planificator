# Secrets

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`.gitignore`, `git ls-files`, `src/lib/encryption.ts`). **Aucun fichier `.env*` n'a été lu pour produire ce kit.** Norme : ES-001 §14.

## Constats

- `.env`, `.env.local`, `.env.development.local`, `.env.test.local`, `.env.production.local` et le motif général `.env*` sont ignorés par Git (`.gitignore`) ; `git ls-files` ne liste **aucun** fichier `.env` suivi.
- Des fichiers `.env*` existent localement dans le dossier de travail principal (dont des variantes `.env.vercel*`, `.env.production.local`). Ils ne doivent jamais être copiés dans un dépôt, un ADR, un rapport d'agent ou un journal.
- Les jetons Gmail sont chiffrés en AES-256-GCM (`src/lib/encryption.ts`, clé dérivée de `GMAIL_TOKEN_ENCRYPTION_KEY`, échec explicite si la variable est absente).
- La plateforme d'intégration interdit les secrets en clair dans `IntegrationConnection`.

## Variables sensibles (NOMS uniquement, relevés dans `process.env.*`)

`DATABASE_URL`, `CRON_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `ACQUISITION_SYSTEM_ACTOR_USER_ID` (identifiant, non secret mais sensible), ainsi que les variables next-auth (`NEXTAUTH_URL` (présent dans `src/`) ; le secret d'authentification next-auth est lu en interne par la bibliothèque — **À CONFIRMER**).

## Règles

1. Un agent n'ouvre pas, n'affiche pas, ne copie pas un `.env*`. Il cite des noms de variables.
2. Les rapports et logs sont **expurgés** : aucun secret, aucun jeton, aucun contenu d'e-mail brut.
3. Un secret exposé (collé dans un chat, un commit, un log) est considéré compromis : **rotation**, pas seulement suppression.
4. Les clés de production et de staging sont distinctes (voir `07-deployment/environments.md`).
5. Un fichier à secrets n'est jamais ajouté à Git ; toute exception passe par un ADR.

## À AUDITER

- Historique Git : absence de secrets commités par le passé (aucun scan effectué).
- Rotation et propriétaire de chaque secret.
