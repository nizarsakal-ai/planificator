# Runbook — rôle applicatif PostgreSQL distinct du propriétaire (prérequis avant d'activer la Comptabilité)

**Constat (audit du 25/10/2026)** : l'application se connecte avec `neondb_owner`, propriétaire des tables. La frontière de privilèges du moteur comptable A1 (fonctions `SECURITY DEFINER`, contrôle `current_user = propriétaire`) est donc inopérante : le propriétaire peut aussi désactiver les déclencheurs. **Bloquant avant `ACCOUNTING_MODULE_ENABLED=true`**, sans effet tant que le module est désactivé.

## Cible

- `neondb_owner` : propriétaire, utilisé **uniquement** pour `prisma migrate deploy` (URL directe saisie à la main, jamais dans Vercel).
- `planificator_app` : rôle de connexion de l'application (Vercel `DATABASE_URL`), droits DML seulement, `EXECUTE` sur les deux fonctions comptables, aucun DDL, pas membre de `neondb_owner` ni de `neon_superuser`.

## Étapes (staging d'abord, puis production)

1. **Créer le rôle en SQL** (console Neon > SQL Editor, connecté en `neondb_owner`), pas via l'écran Roles (qui ajoute `neon_superuser`). Le mot de passe est choisi et saisi par Nizar, jamais transmis dans un chat :
   ```sql
   CREATE ROLE planificator_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '<à saisir>';
   GRANT CONNECT ON DATABASE neondb TO planificator_app;
   GRANT USAGE ON SCHEMA public TO planificator_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO planificator_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO planificator_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO planificator_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO planificator_app;
   GRANT EXECUTE ON FUNCTION accounting_post_entry(text, text, text), accounting_advance_fiscal_year(text, text, text, text) TO planificator_app;
   ```
2. **Vérifier** (lecture seule) :
   ```sql
   SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'planificator_app';
   SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'planificator_app'; -- doit être vide
   SELECT has_function_privilege('planificator_app', 'accounting_post_entry(text,text,text)', 'EXECUTE');
   ```
3. **Staging** : mettre l'URL `planificator_app` (avec pooler) dans `DATABASE_URL` du projet Vercel `planificator-staging`, redéployer, parcourir chantiers / factures / véhicules / acquisition et surveiller les erreurs `permission denied` (journaux Vercel) pendant au moins une journée d'usage.
4. **Production** : même opération sur le projet `planificator` (variable `DATABASE_URL`, environnement Production), redéployer, surveiller. Retour arrière : remettre l'ancienne valeur de `DATABASE_URL` et redéployer.
5. **Migrations futures** : toujours avec l'URL directe `neondb_owner` (script `etape4-migrer.sh` ou équivalent). Les privilèges par défaut ci-dessus donnent automatiquement les droits DML sur les nouvelles tables ; toute nouvelle fonction `SECURITY DEFINER` exige son `GRANT EXECUTE` explicite.
