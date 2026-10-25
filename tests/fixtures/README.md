# tests/fixtures

Fichiers de recette locaux, uniquement synthétiques (aucune donnée réelle, aucun secret).

- Le script `scripts/verification/vehicle-v3-real-providers.ts` génère lui-même ses fixtures (PNG, PDF texte, PDF image-seule) sans réseau.
- L'option `--fixture <chemin>` n'accepte qu'un PNG situé dans ce dossier (chemin réel, liens sortants refusés). Les adresses qu'il contient doivent être déclarées avec `--expect-address` (au moins deux), par exemple pour `vehicules/v3-addresses-synthetic.png` : `--expect-address "12 rue des Lilas 75012 Paris" --expect-address "8 avenue des Fleurs 31000 Toulouse"`.
- Pour visualiser les fixtures générées : `npx tsx scripts/verification/vehicle-v3-real-providers.ts --mode fixtures --dump /tmp/recette-fixtures`.
