# Preuves `tsc` / `build` de référence sur BASE_SHA (fiche rév. 3, §3.3 et §9.2)

Captures réalisées dans le worktree de référence `planificator-lot-1w-1a-ref`, HEAD détaché sur
`BASE_SHA = a84c73fe7e89c04943e356df99679fe0aca83ed1`, **avant** l'ajout du harnais (arbre vierge),
Node v22.23.4, dépendances installées par `npm ci` depuis le `package-lock.json` de BASE_SHA.

| Fichier | Commande | Contenu |
|---------|----------|---------|
| `tsc-raw.txt`, `tsc-exit.txt` | `npx tsc --noEmit > tsc-raw.txt 2>&1; echo $? > tsc-exit.txt` | journal brut, code de sortie (2 = erreurs préexistantes, toutes sous `tests/`) |
| `tsc-normalized.txt` | `perl -pe "s#<chemin absolu du worktree>#<WORKTREE>#g" tsc-raw.txt \| sort` | copie normalisée pour `diff` avant/après |
| `next-build-raw.txt`, `next-build-exit.txt` | `npm run build > next-build-raw.txt 2>&1; echo $? > next-build-exit.txt` (variables factices de `build-env.txt`) | journal brut, code de sortie (0) |
| `next-build-normalized.txt` | `perl -pe` : chemin du worktree → `<WORKTREE>` ; durées `N ms`/`N s` → `<T>` ; tailles `N B/kB/MB` → `<SIZE>` ; ligne `Tip:` de Prisma (astuce aléatoire) → `<ASTUCE PRISMA ALÉATOIRE>` ; **ordre conservé** (pas de `sort`) | copie normalisée |
| `build-env.txt` | — | variables d'environnement factices utilisées (aucun secret) |

Constat : `npm run build` (next-pwa) **réécrit le fichier suivi `public/sw.js`** (noms de variables du
minifieur). Il a été restauré par `git checkout -- public/sw.js` (ce seul fichier) ; le worktree de
référence est resté byte-identique à BASE_SHA hors `tests/chantiers/parity/**`.
