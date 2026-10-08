# Périmètre

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour l'inventaire des domaines (schéma Prisma, `src/`, `tests/`) ; l'état de chaque module est dans `05-domains/modules-status.md`.

## Dans le périmètre de ce Spec Kit

Tout le dépôt Planificator : `src/`, `prisma/`, `scripts/`, `tests/`, `docs/`, configuration de déploiement (`vercel.json`, `next.config.ts`).

## Hors périmètre

- La norme ES-001 (copie protégée ; source canonique hors dépôt, voir `docs/constitution/README.md` §Adoption).
- Les valeurs de secrets et les fichiers `.env*` (jamais lus, jamais copiés ici — voir `03-security/secrets.md`).
- Les évolutions non spécifiées. Une évolution n'existe pas tant qu'elle n'a pas de spec dans `08-specs/active/`.

## Règle anti-dérive

Quand une spec dit « hors périmètre », l'agent **n'ajoute pas** la fonctionnalité, même si elle semble évidente. Exemple actuel : Vehicles V2 (kilométrage) n'inclut ni vidange, ni contrôle technique, ni GPS, ni télématique (voir `08-specs/active/vehicles-v2-mileage/spec.md`).
