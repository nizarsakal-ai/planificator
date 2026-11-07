// Génère le module de réponses simulées de next/font/google (NEXT_FONT_GOOGLE_MOCKED_RESPONSES, next 15.5.18) à partir
// du média, HORS LIGNE (PRÉPARÉ, NON EXÉCUTÉ). Pour chaque URL CSS exacte (polices-google.tsv), le CSS récupéré sur le Mac
// est repris tel quel, seules les URL fonts.gstatic.com étant remplacées par le chemin ABSOLU du fichier local, que
// next 15.5.18 lit sur le disque (fetch-font-file.js). Chaque fichier est revérifié par son empreinte. Écart = arrêt.
// Usage : node generer-mock-polices.cjs <racine-média> <dossier-sortie>
"use strict"
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto")
const [media, out] = process.argv.slice(2)
if (!media || !out) { console.error("usage : generer-mock-polices.cjs <média> <sortie>"); process.exit(2) }
const tsv = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"))
fs.mkdirSync(path.join(out, "fichiers"), { recursive: true })
const index = tsv(path.join(media, "polices", "INDEX.tsv")) // css, url_fichier, nom, sha256
const byUrl = new Map()
for (const [css, url, nom, sha] of index) {
  const src = path.join(media, "polices", "fichiers", nom)
  const buf = fs.readFileSync(src)
  if (crypto.createHash("sha256").update(buf).digest("hex") !== sha) { console.error(`ÉCHEC empreinte police ${nom}`); process.exit(1) }
  const dst = path.join(out, "fichiers", nom)
  fs.writeFileSync(dst, buf)
  byUrl.set(url, dst)
}
const mock = {}
for (const [cssFile, cssUrl] of tsv(path.join(media, "polices-google.tsv"))) {
  let css = fs.readFileSync(path.join(media, "polices", cssFile), "utf8")
  const urls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) || [])]
  if (urls.length === 0) { console.error(`ÉCHEC : aucun fichier dans ${cssFile}`); process.exit(1) }
  for (const u of urls) {
    const local = byUrl.get(u)
    if (!local) { console.error(`ÉCHEC : fichier absent du média pour ${u}`); process.exit(1) }
    css = css.split(u).join(local)
  }
  mock[cssUrl] = css
  console.log(`ok ${cssUrl} (${urls.length} fichiers)`)
}
fs.writeFileSync(path.join(out, "mock.cjs"), `module.exports = ${JSON.stringify(mock, null, 1)}\n`)
