# Domaine — Navigation

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** sur `origin/main` (commits `63bc6d4` #65 « centralize nav config », `d2695fd` #66 « resolve a single active nav item »).

| Élément | Constat |
|---------|---------|
| Config centrale | `src/lib/navigation/nav-config.ts` |
| Composants | `src/components/layout/` (Sidebar, MobileNav) |
| Tests | `tests/navigation/nav-config.test.ts` (`npm run test:navigation`) |

## Travail en cours (hors `main`, non audité par ce kit)

La branche `feat/navigation-modular-sections` (checkout principal) contient des modifications non commitées (sections de navigation modulaires, `NavSections.tsx`). **Ne pas les inclure** dans ce kit ni les écraser.

## Règle

La navigation reflète les droits, elle ne les **applique** pas : chaque page et route reste protégée côté serveur (`03-security/rbac.md`).
