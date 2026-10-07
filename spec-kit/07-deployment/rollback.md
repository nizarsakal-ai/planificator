# Rollback

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : principes **VÉRIFIÉS** dans les en-têtes des migrations Vehicles ; procédure générale = règle du kit. Norme : ES-001 §24.

## Code

Re-déployer le déploiement précédent depuis Vercel **si le code précédent reste compatible avec la base actuelle** (c'est pourquoi chaque migration documente la compatibilité ancien code ↔ nouvelle base).

## Base de données

- **Échec d'une migration** (transaction annulée) : lire le diagnostic `RAISE EXCEPTION` ; corriger les données **explicitement** ; `prisma migrate resolve --rolled-back <migration>` ; relancer `migrate deploy`. **Sans autorisation explicite de l'utilisateur : ne pas exécuter.**
- **Rollback manuel après commit** : compensation écrite dans l'en-tête (ex. V1B-db : recréer les trois FK d'origine et supprimer les deux CHECK ; le BACKFILL n'est pas réversible mais inoffensif. V1C : `DROP COLUMN "modele"` perd les modèles saisis depuis).
- **Interdit sans exception** : `migrate reset`, `db push`, `migrate dev`, suppression de données de production pour « réparer ».

## Flags

Désactiver le flag (retour au comportement inactif par défaut) est le premier levier pour les capacités à effet externe ; documenter qui peut le faire.

## À AUDITER

Stratégie de restauration (snapshots Neon) et temps de restauration attendu ; test de restauration réalisé ou non.
