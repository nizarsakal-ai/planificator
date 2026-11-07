#!/usr/bin/env bash
# Contrôle lint NON INTERACTIF du candidat devis (07/11/2026, après le blocage de la campagne 02 de 7e6038df sur l'invite de
# `next lint`). À lancer DANS le confinement, répertoire courant = racine du dépôt : bash <ce-dossier>/controle-lint.sh <preuves>
#
# Constat (code de next 15.5.18, lib/eslint/runLintCheck.js) : `main` n'a AUCUNE configuration ESLint ; `next lint` ouvre alors
# l'assistant interactif (Strict / Base / Cancel). `next build` ignore ESLint sans configuration : la production n'a jamais été
# lintée. On ne crée PAS de configuration dans le produit (elle activerait ESLint dans le build Vercel : hors périmètre).
#  1. Si une configuration ESLint existe dans l'arbre : `npm run lint` tel quel, entrée fermée, BLOQUANT.
#  2. Sinon : constat écrit, puis
#     a. lint INFORMATIF, NON BLOQUANT, de tout src/ (état de référence de main, jamais linté) avec la configuration « Strict »
#        que l'assistant aurait écrite (next/core-web-vitals + next/typescript) ;
#     b. lint BLOQUANT des 19 fichiers src/ du lot (liste fermée), même configuration, même règle de sortie que `next lint`
#        (échec sur erreur, avertissements consignés). Chaque fichier attendu doit figurer dans le résultat : rien n'est ignoré.
set -euo pipefail
P="$1"; H="$(cd "$(dirname "$0")" && pwd)"; CFG="$H/eslint-controle.json"; LST="$H/fichiers-lint-lot.txt"
[ -d "$P" ] || { echo "ÉCHEC : dossier de preuves absent : $P" >&2; exit 1; }

PRESENTS=""
for f in .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yaml .eslintrc.yml eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts eslint.config.mts eslint.config.cts; do
  [ -e "$f" ] && PRESENTS="$PRESENTS $f"
done
node -e 'process.exit(require("./package.json").eslintConfig ? 0 : 1)' && PRESENTS="$PRESENTS package.json#eslintConfig"
if [ -n "$PRESENTS" ]; then
  echo "configuration ESLint présente :$PRESENTS ; contrôle = npm run lint (bloquant, entrée fermée)" | tee "$P/lint-constat-configuration.txt"
  npm run lint < /dev/null
  exit $?
fi
{ echo "configuration_eslint=absente (aucun .eslintrc*, eslint.config.*, package.json#eslintConfig)"
  echo "npm_run_lint=non_executable_sans_interaction (next lint ouvre l'assistant Strict/Base/Cancel ; Cancel => code 1)"
  echo "next_build=ESLint ignoré sans configuration (lintDuringBuild) : production jamais lintée"
  echo "controle_bloquant=eslint fichiers du lot, configuration Strict de next 15.5.18 ($CFG)"
  echo "eslint=$(npx --no-install eslint --version)"; } | tee "$P/lint-constat-configuration.txt"

RESUME='
const fs = require("fs"), path = require("path");
const [json, mode, code, lst] = process.argv.slice(1);
let r; try { r = JSON.parse(fs.readFileSync(json, "utf8")); } catch (e) { console.log("résultat ESLint illisible : " + e.message); process.exit(1); }
let err = 0, warn = 0, fatal = 0;
for (const f of r) {
  err += f.errorCount; warn += f.warningCount; fatal += f.fatalErrorCount || 0;
  for (const m of f.messages) console.log(`${path.relative(process.cwd(), f.filePath)}:${m.line ?? 0}:${m.column ?? 0} ${m.severity === 2 ? "erreur" : "avertissement"} ${m.ruleId ?? "analyse"} ${m.message}`);
}
console.log(`fichiers=${r.length} erreurs=${err} avertissements=${warn} erreurs_fatales=${fatal} code_eslint=${code}`);
if (mode === "informatif") process.exit(0);
const want = fs.readFileSync(lst, "utf8").split("\n").filter(l => l && !l.startsWith("#")).sort();
const got = r.map(f => path.relative(process.cwd(), f.filePath)).sort();
const manq = want.filter(x => !got.includes(x)), trop = got.filter(x => !want.includes(x));
if (manq.length || trop.length) { console.log("ÉCART de couverture ; manquants=" + JSON.stringify(manq) + " en_trop=" + JSON.stringify(trop)); process.exit(1); }
process.exit(code === "0" && err === 0 && fatal === 0 ? 0 : 1);
'
E=(npx --no-install eslint --no-eslintrc -c "$CFG" --resolve-plugins-relative-to . --format json)

set +e
"${E[@]}" --ext .js,.jsx,.ts,.tsx --output-file "$P/lint-global-informatif.json" src < /dev/null > "$P/lint-global-informatif-eslint.log" 2>&1
GC=$?
set -e
{ echo "INFORMATIF, NON BLOQUANT : état de référence de src/ (main n'a jamais été linté)."; node -e "$RESUME" "$P/lint-global-informatif.json" informatif "$GC" || true; } > "$P/lint-global-informatif.txt"
tail -1 "$P/lint-global-informatif.txt"

mapfile -t FILES < <(grep -v '^#' "$LST" | sed '/^$/d')
[ "${#FILES[@]}" -eq 19 ] || { echo "ÉCHEC : liste du lot : ${#FILES[@]} fichiers au lieu de 19" >&2; exit 1; }
for f in "${FILES[@]}"; do [ -f "$f" ] || { echo "ÉCHEC : fichier du lot absent : $f" >&2; exit 1; }; done
set +e
"${E[@]}" --output-file "$P/lint-lot.json" "${FILES[@]}" < /dev/null > "$P/lint-lot-eslint.log" 2>&1
LC=$?
set -e
echo "BLOQUANT : 19 fichiers src/ du lot."
node -e "$RESUME" "$P/lint-lot.json" bloquant "$LC" "$LST" | tee "$P/lint-lot.txt"
exit "${PIPESTATUS[0]}"
