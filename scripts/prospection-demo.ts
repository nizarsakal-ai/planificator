/**
 * Veille prospection — démonstration locale en lecture seule.
 *
 * Interroge les vraies sources publiques (BOAMP, liste des festivals), applique le dédoublonnage, le score et l'ordre
 * de priorité géographique, puis écrit un rapport HTML. Aucune écriture en base, aucun envoi : seulement des GET publics.
 *
 *   npx tsx scripts/prospection-demo.ts --days 30 --out /chemin/rapport.html [--theme light|dark]
 */
import { writeFileSync } from "node:fs"
import { keepForStorage, scoreAndDedupe } from "@/lib/prospection/prospection-watch.service"
import type { ProspectKind, ScoredCandidate } from "@/lib/prospection/prospection.types"
import { BAND_LABELS, OPPORTUNITY_TABS, SOURCE_ATTRIBUTION, deadlineLabel, departmentsLabel, sentenceCase } from "@/lib/prospection/prospection-ui"
import { PRIORITY_GROUPS, isRecentlyClosedWorthRecontact, priorityGroupsFor, priorityRankFor } from "@/lib/prospection/priority"
import { fetchBoampCandidates } from "@/lib/prospection/sources/boamp.source"
import { fetchFestivalCandidates } from "@/lib/prospection/sources/festivals-culture.source"

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const days = Math.min(90, Math.max(1, Number.parseInt(arg("days", "30"), 10) || 30))
const out = arg("out", "prospection-demo.html")
const theme = arg("theme", "")
const now = new Date()
const PER_GROUP = 6

const escape = (value: string | null | undefined) =>
  (value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string)

const fmtShort = (date: Date | null) =>
  date ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" }).format(date) : ""

function row(item: ScoredCandidate): string {
  const meta: string[] = []
  if (item.organization) meta.push(escape(sentenceCase(item.organization)))
  else if (item.locality) meta.push(escape(item.locality))
  if (item.departmentCodes.length) meta.push(departmentsLabel(item.departmentCodes))
  let when = ""
  if (item.kind === "TENDER") {
    const label = deadlineLabel(item.deadlineAt, now)
    when = item.deadlineAt ? `<span class="when${label && /Dans [0-9] jours|Demain|Aujourd/.test(label) ? " soon" : ""}">Limite ${fmtShort(item.deadlineAt)} · ${escape(label?.replace("Dans ", "").replace(" jours", " j"))}</span>` : `<span class="when">Limite non publiée</span>`
  } else if (item.kind === "AWARD") {
    when = `<span class="when">Attribué le ${fmtShort(item.publishedAt)}</span>`
  } else if (item.eventPeriod) {
    when = `<span class="when">${escape(item.eventPeriod.replace(/\s*\(.*\)$/, ""))}</span>`
  }
  const winners = item.winners.length ? `<p class="winners">À démarcher : <b>${escape(item.winners.join(" · "))}</b></p>` : ""
  const reasons = item.reasons.map((r) => `<li><span>${escape(r.label)}</span><span>${r.points > 0 ? "+" : ""}${r.points}</span></li>`).join("")
  const title = escape(sentenceCase(item.title))
  return `<li class="row">
    <span class="score ${item.band}" title="${BAND_LABELS[item.band]}">${item.score}</span>
    <div class="body">
      <a class="title" href="${escape(item.url ?? "#")}" target="_blank" rel="noopener noreferrer">${title}</a>
      <p class="meta">${meta.join(" · ")}${when ? ` ${when}` : ""}</p>
      ${winners}
      <details><summary>Pourquoi ${item.score} ?</summary><ul class="reasons">${reasons}</ul><p class="src">${SOURCE_ATTRIBUTION[item.source]}</p></details>
    </div>
    <span class="status">Nouveau</span>
  </li>`
}

/** Appels d'offres clos récemment qui auraient été retenus : à recontacter au prochain marché. */
function isRecentlyClosed(item: ScoredCandidate): boolean {
  return isRecentlyClosedWorthRecontact({ ...item, priorityGroup: priorityRankFor(item) }, now)
}

function closedLine(items: ScoredCandidate[]): string {
  if (items.length === 0) return ""
  const entries = items
    .map((item) => `<li><b>${escape(sentenceCase(item.organization ?? ""))}</b> — ${escape(sentenceCase(item.title))} <span>· clos le ${fmtShort(item.deadlineAt)}</span></li>`)
    .join("")
  return `<details class="closed"><summary>Clos récemment · ${items.length} — à recontacter au prochain marché</summary><ul>${entries}</ul></details>`
}

function groups(items: ScoredCandidate[], kind: ProspectKind, closed: ScoredCandidate[] = []): string {
  return priorityGroupsFor(kind).map((group, index) => {
    const position = index + 1
    const inGroup = items.filter((item) => priorityRankFor(item) === group.rank).sort((a, b) => b.score - a.score)
    const closedHere = group.rank <= 2 ? closed.filter((item) => priorityRankFor(item) === group.rank) : []
    if (inGroup.length === 0) {
      return `<div class="group${closedHere.length ? "" : " empty"}"><h3><span class="rank">${position}</span>${group.label}<span class="n">0</span></h3>${closedLine(closedHere)}</div>`
    }
    const shown = inGroup.slice(0, PER_GROUP)
    const more = inGroup.length - shown.length
    return `<div class="group"><h3><span class="rank">${position}</span>${group.label}<span class="n">${inGroup.length}</span></h3>
      <ul class="rows">${shown.map(row).join("")}</ul>${more > 0 ? `<p class="more">+ ${more} autre(s)</p>` : ""}${closedLine(closedHere)}</div>`
  }).join("")
}

async function main() {
  const [boamp, festivals] = await Promise.all([
    fetchBoampCandidates({ now, lookbackDays: days, maxRecords: 1000 }),
    fetchFestivalCandidates(),
  ])
  const stored = scoreAndDedupe([...boamp, ...festivals], now).filter(keepForStorage)
  const visible = (kind: ProspectKind) => stored.filter((item) => item.kind === kind && item.band !== "MASQUE")
  const closedTenders = stored.filter(isRecentlyClosed)

  const summary = Object.fromEntries(
    OPPORTUNITY_TABS.map((tab) => [
      tab.label,
      Object.fromEntries(PRIORITY_GROUPS.map((group) => [group.label, visible(tab.kind).filter((item) => priorityRankFor(item) === group.rank).length])),
    ]),
  )
  console.log(JSON.stringify({ fenetreJours: days, boampAvisCollectes: boamp.length, festivalsLus: festivals.length, parGroupe: summary }, null, 2))

  const tabs = OPPORTUNITY_TABS.map(
    (tab, index) => `<span class="tab${index === 0 ? " on" : ""}">${tab.label}<b>${visible(tab.kind).length}</b></span>`,
  ).join("")
  const sections = OPPORTUNITY_TABS.map(
    (tab, index) => `<section>${index > 0 ? `<h2>Onglet « ${tab.label} »</h2>` : ""}<p class="hint">${escape(tab.hint)}</p>${groups(visible(tab.kind), tab.kind, tab.kind === "TENDER" ? closedTenders : [])}</section>`,
  ).join("")

  const html = `<!doctype html><html lang="fr"${theme ? ` data-theme="${theme}"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opportunités Galya</title>
<style>
:root{--bg:#f6f1e7;--card:#fffdf8;--ink:#14213d;--muted:#6a7183;--line:#e7dfcf;--soft:#efe8da;--ok:#1f7a4d;--warn:#b7791f;--accent:#1d3b8b;--soon:#b42318}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1424;--card:#151d31;--ink:#e8ecf5;--muted:#9aa4ba;--line:#26304a;--soft:#1b2440;--ok:#4cc38a;--warn:#f0b54a;--accent:#9db5ff;--soon:#ff8a80}}
:root[data-theme="dark"]{--bg:#0e1424;--card:#151d31;--ink:#e8ecf5;--muted:#9aa4ba;--line:#26304a;--soft:#1b2440;--ok:#4cc38a;--warn:#f0b54a;--accent:#9db5ff;--soon:#ff8a80}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:24px;margin:0}.lead{color:var(--muted);margin:4px 0 18px;font-size:14px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:6px}
.tab{padding:6px 12px;border-radius:999px;font-size:14px;color:var(--muted);display:inline-flex;gap:8px;align-items:center}
.tab b{font-weight:600;font-size:12px;background:var(--soft);color:var(--ink);border-radius:999px;padding:1px 8px}
.tab.on{background:var(--ink);color:var(--bg)}.tab.on b{background:var(--bg);color:var(--ink)}
.hint{color:var(--muted);font-size:13px;margin:10px 0 14px}
h2{font-size:17px;margin:40px 0 0;padding-top:20px;border-top:1px dashed var(--line)}
.group{margin:0 0 18px}.group h3{display:flex;align-items:center;gap:10px;font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;font-weight:600}
.rank{width:22px;height:22px;border-radius:50%;display:inline-grid;place-items:center;background:var(--accent);color:var(--bg);font-size:12px}
.n{margin-left:auto;font-variant-numeric:tabular-nums}.group.empty h3{opacity:.45}.group.empty .rank{background:var(--muted)}
.rows{list-style:none;margin:0;padding:0;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.row{display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:start;padding:12px 14px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.score{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-weight:700;font-variant-numeric:tabular-nums;font-size:15px}
.A_TRAITER{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}.A_VERIFIER{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.body{min-width:0}.title{color:var(--ink);text-decoration:none;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.title:hover{text-decoration:underline}
.meta{margin:3px 0 0;font-size:13px;color:var(--muted)}.when{white-space:nowrap;margin-left:4px;padding-left:8px;border-left:1px solid var(--line)}.when.soon{color:var(--soon);font-weight:600}
.winners{margin:4px 0 0;font-size:13px}details{margin-top:4px;font-size:12px}summary{cursor:pointer;color:var(--muted);list-style:none}summary::-webkit-details-marker{display:none}
.reasons{list-style:none;padding:0;margin:6px 0}.reasons li{display:flex;justify-content:space-between;gap:12px;padding:1px 0}.reasons li span:last-child{color:var(--muted);font-variant-numeric:tabular-nums}.src{color:var(--muted)}
.status{font-size:12px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;color:var(--muted);white-space:nowrap}
.more{font-size:13px;color:var(--accent);margin:6px 2px 0}
.closed{margin:8px 2px 0;font-size:13px}.closed summary{color:var(--accent);font-weight:500}.closed ul{list-style:none;margin:6px 0 0;padding:0 0 0 12px;border-left:2px solid var(--line)}.closed li{color:var(--muted);padding:2px 0}.closed li b{color:var(--ink);font-weight:600}.closed li span{white-space:nowrap}
footer{margin-top:36px;font-size:12px;color:var(--muted)}
@media (max-width:560px){.row{grid-template-columns:40px 1fr}.status{grid-column:2;justify-self:start}.score{width:36px;height:36px;font-size:14px}.when{display:block;border:0;margin:2px 0 0;padding:0}}
</style></head><body><main>
<h1>Opportunités</h1>
<p class="lead">Classées dans votre ordre : mairies d'Île-de-France, montage-démontage en Île-de-France, autres pistes franciliennes, départements voisins, puis le reste de la France. Le chiffre est le score de pertinence métier.</p>
<div class="tabs">${tabs}</div>
${sections}
<footer>Maquette sur données réelles du ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(now)} (BOAMP sur ${days} jours, festivals du ministère de la Culture). Lecture seule : rien n'est enregistré ni envoyé. Sources : ${SOURCE_ATTRIBUTION.BOAMP} ; ${SOURCE_ATTRIBUTION.FESTIVALS_CULTURE}.</footer>
</main></body></html>`
  writeFileSync(out, html)
  console.log(`Rapport écrit : ${out}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
