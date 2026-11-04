/**
 * Veille prospection — démonstration locale en lecture seule.
 *
 * Interroge les vraies sources publiques (BOAMP, liste des festivals), applique le dédoublonnage et le score,
 * puis écrit un rapport HTML. Aucune écriture en base, aucun envoi : seulement des requêtes GET publiques.
 *
 *   npx tsx scripts/prospection-demo.ts --days 30 --out /chemin/rapport.html
 */
import { writeFileSync } from "node:fs"
import { keepForStorage, scoreAndDedupe } from "@/lib/prospection/prospection-watch.service"
import type { ProspectKind, ScoredCandidate } from "@/lib/prospection/prospection.types"
import { BAND_LABELS, OPPORTUNITY_TABS, SOURCE_ATTRIBUTION, deadlineLabel } from "@/lib/prospection/prospection-ui"
import { fetchBoampCandidates } from "@/lib/prospection/sources/boamp.source"
import { DEPARTMENT_LABELS } from "@/lib/prospection/sources/departments"
import { fetchFestivalCandidates } from "@/lib/prospection/sources/festivals-culture.source"

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const days = Math.min(90, Math.max(1, Number.parseInt(arg("days", "30"), 10) || 30))
const out = arg("out", "prospection-demo.html")
const now = new Date()

const escape = (value: string | null | undefined) =>
  (value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string)

const fmtDay = (date: Date | null) =>
  date ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Paris" }).format(date) : ""

function card(item: ScoredCandidate): string {
  const place = [item.locality, ...item.departmentCodes.map((code) => `${DEPARTMENT_LABELS.get(code) ?? "?"} (${code})`)].filter(Boolean).join(" · ")
  const facts: string[] = []
  if (item.kind === "TENDER") facts.push(`Date limite : <b>${item.deadlineAt ? `${fmtDay(item.deadlineAt)} (${deadlineLabel(item.deadlineAt, now)})` : "non publiée"}</b>`)
  if (item.kind !== "EVENT" && item.publishedAt) facts.push(`Publié le ${fmtDay(item.publishedAt)}`)
  if (item.eventPeriod) facts.push(`Période : ${escape(item.eventPeriod)}`)
  if (item.winners.length) facts.push(`Titulaire(s) à démarcher : <b>${escape(item.winners.join(", "))}</b>`)
  const reasons = item.reasons.map((r) => `<li><span>${escape(r.label)}</span><span>${r.points > 0 ? "+" : ""}${r.points}</span></li>`).join("")
  const title = item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.title)} ↗</a>` : escape(item.title)
  return `<li class="card">
    <div class="top"><span class="band ${item.band}">${item.score} · ${BAND_LABELS[item.band]}</span><span class="status">Nouveau</span></div>
    <h3>${title}</h3>
    <p class="meta">${escape([item.organization, place].filter(Boolean).join(" — ") || "Lieu non précisé")}</p>
    <p class="facts">${facts.join(" · ")}</p>
    <details><summary>Pourquoi ce score ?</summary><ul class="reasons">${reasons}</ul><p class="src">Source : ${SOURCE_ATTRIBUTION[item.source]}</p></details>
  </li>`
}

async function main() {
  const [boamp, festivals] = await Promise.all([
    fetchBoampCandidates({ now, lookbackDays: days, maxRecords: 1000 }),
    fetchFestivalCandidates(),
  ])
  const scored = scoreAndDedupe([...boamp, ...festivals], now)
  const stored = scored.filter(keepForStorage)

  const byKind = (kind: ProspectKind) => stored.filter((item) => item.kind === kind)
  const count = (items: ScoredCandidate[], band: string) => items.filter((item) => item.band === band).length
  const visible = (items: ScoredCandidate[]) => items.filter((item) => item.band !== "MASQUE")

  const summary = {
    fenetreJours: days,
    boampAvisCollectes: boamp.length,
    festivalsLus: festivals.length,
    apresDedoublonnage: scored.length,
    aEnregistrer: stored.length,
    appelsOffres: { aTraiter: count(byKind("TENDER"), "A_TRAITER"), aVerifier: count(byKind("TENDER"), "A_VERIFIER"), masques: count(byKind("TENDER"), "MASQUE") },
    attributions: { aTraiter: count(byKind("AWARD"), "A_TRAITER"), aVerifier: count(byKind("AWARD"), "A_VERIFIER"), masques: count(byKind("AWARD"), "MASQUE") },
    festivals: { aTraiter: count(byKind("EVENT"), "A_TRAITER"), aVerifier: count(byKind("EVENT"), "A_VERIFIER") },
  }
  console.log(JSON.stringify(summary, null, 2))

  const sections = OPPORTUNITY_TABS.map((tab) => {
    const items = visible(byKind(tab.kind)).sort((a, b) => b.score - a.score).slice(0, tab.kind === "EVENT" ? 15 : 25)
    const total = visible(byKind(tab.kind)).length
    return `<section><h2>${tab.label} <span class="count">${total}</span></h2><p class="hint">${escape(tab.hint)}</p>
      ${items.length ? `<ul class="list">${items.map(card).join("")}</ul>` : `<p class="empty">Aucune piste sur la période.</p>`}
      ${total > items.length ? `<p class="more">… et ${total - items.length} autre(s), visibles dans l'application.</p>` : ""}</section>`
  }).join("")

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opportunités Galya</title>
<style>
:root{--bg:#f6f1e7;--card:#fffdf8;--ink:#14213d;--muted:#5b6475;--line:#e4dccb;--ok:#d9f2e3;--okt:#14532d;--warn:#fbecc8;--warnt:#78350f;--accent:#1d3b8b}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1424;--card:#161e33;--ink:#e8ecf5;--muted:#a3adc2;--line:#28324d;--ok:#14532d;--okt:#d9f2e3;--warn:#78350f;--warnt:#fbecc8;--accent:#9db5ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 4px}
.lead,.hint,.meta,.more,.empty,.src{color:var(--muted)}.lead{margin:0 0 16px}.hint{margin:0 0 12px;font-size:14px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;min-width:150px}
.stat b{display:block;font-size:22px}.count{font-size:14px;color:var(--muted);font-weight:500}
.list{list-style:none;padding:0;margin:0;display:grid;gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.top{display:flex;gap:8px;align-items:center}.band{font-size:12px;font-weight:700;border-radius:999px;padding:2px 10px}
.A_TRAITER{background:var(--ok);color:var(--okt)}.A_VERIFIER{background:var(--warn);color:var(--warnt)}.status{font-size:12px;color:var(--accent);font-weight:600}
h3{font-size:15px;margin:8px 0 2px;overflow-wrap:anywhere}h3 a{color:inherit}.meta{margin:0;font-size:13px}.facts{margin:8px 0 0;font-size:13px}
details{margin-top:8px;font-size:13px}summary{cursor:pointer;color:var(--muted)}.reasons{list-style:none;padding:0;margin:6px 0}
.reasons li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dashed var(--line);padding:2px 0}.reasons li span:last-child{font-variant-numeric:tabular-nums;color:var(--muted)}
footer{margin-top:40px;font-size:13px;color:var(--muted)}
</style></head><body><main>
<h1>Opportunités — démonstration</h1>
<p class="lead">Données réelles collectées le ${fmtDay(now)} (BOAMP sur ${days} jours, liste des festivals du ministère de la Culture). Lecture seule : rien n'a été enregistré ni envoyé.</p>
<div class="stats">
<div class="stat"><b>${boamp.length}</b>avis BOAMP collectés</div>
<div class="stat"><b>${summary.appelsOffres.aTraiter} + ${summary.appelsOffres.aVerifier}</b>appels d'offres (à traiter + à vérifier)</div>
<div class="stat"><b>${summary.attributions.aTraiter} + ${summary.attributions.aVerifier}</b>attributions (sous-traitance)</div>
<div class="stat"><b>${summary.festivals.aTraiter} + ${summary.festivals.aVerifier}</b>festivals retenus sur ${festivals.length}</div>
</div>
${sections}
<footer>Sources : ${SOURCE_ATTRIBUTION.BOAMP} ; ${SOURCE_ATTRIBUTION.FESTIVALS_CULTURE}. Aucune donnée de particulier n'est lue (ni e-mail, ni nom de correspondant, ni adresse postale).</footer>
</main></body></html>`
  writeFileSync(out, html)
  console.log(`Rapport écrit : ${out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
