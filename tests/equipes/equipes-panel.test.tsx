// Panneau droit Équipes V2 (PR B). Lancer via `npm run test:equipes`.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { EquipesSidePanel } from "@/components/equipes/EquipesSidePanel"
import { markerIconHtml, markerTooltip } from "@/components/equipes/EquipesMap"
import {
  addDbDays,
  assignmentsOnDbDate,
  buildInterventionMap,
  buildMarkerPopupHtml,
  escapeHtml,
  formatDbDate,
  getCurrentInterventions,
  getPlanningHref,
  getQuickActions,
  getUpcomingInterventions,
  hasValidCoordinates,
  parisTodayAsDbDate,
  safeTeamColor,
  toEquipeViewItems,
  UPCOMING_SEE_ALL_HREF,
  type AssignmentWindowRow,
  type EquipeRow,
} from "@/lib/equipes/equipes-view"

;(globalThis as { React?: typeof React }).React = React

const CO = "co-1"
const OTHER = "co-2"

// 22:30 UTC le 14 juillet = déjà le 15 juillet à Paris.
const NOW = new Date("2026-07-14T22:30:00Z")
const TODAY = parisTodayAsDbDate(NOW)
const D = (offset: number) => addDbDays(TODAY, offset)

const team = (id: string, name: string, over: Partial<EquipeRow> = {}): EquipeRow => ({
  id,
  companyId: CO,
  name,
  color: "#123456",
  active: true,
  leader: { id: "l-" + id, firstName: "Chef", lastName: name, companyId: CO },
  members: [],
  truck: null,
  ...over,
})

const ws = (id: string, name: string, lat: number | null, lng: number | null, companyId = CO) => ({
  id,
  name,
  latitude: lat,
  longitude: lng,
  companyId,
})

const a = (teamId: string, date: Date, worksite: AssignmentWindowRow["worksite"], status = "CONFIRMED"): AssignmentWindowRow => ({
  teamId,
  date,
  status,
  worksite,
})

const TEAMS: EquipeRow[] = [
  team("t-a", "Alpha"),
  team("t-b", "Bravo"),
  team("t-c", "Charlie"),
  team("t-d", "Delta"),
  team("t-e", "Echo"),
  team("t-f", "Foxtrot"),
  team("t-arch", "Archivée", { active: false }),
  team("t-x", "Étrangère", { companyId: OTHER }),
]

const PINS = ws("w-pins", "Résidence Les Pins", 48.85, 2.35)
const NOCOORD = ws("w-nocoord", "Chantier sans GPS", null, null)

const ROWS: AssignmentWindowRow[] = [
  // Aujourd'hui (Paris)
  a("t-a", D(0), PINS),
  a("t-b", D(0), PINS), // même chantier qu'Alpha → regroupé
  a("t-c", D(0), NOCOORD), // non localisée
  a("t-d", D(0), ws("w-p", "Pending", 45, 5), "PENDING"),
  a("t-e", D(0), ws("w-r", "Refused", 44, 4), "REFUSED"),
  a("t-arch", D(0), ws("w-arch", "Archivé", 43, 3)),
  a("t-x", D(0), ws("w-x", "Autre tenant", 42, 2, OTHER)),
  a("t-f", D(0), ws("w-foreign", "Chantier étranger", 41, 1, OTHER)),
  // Hier (UTC « 14 juillet ») : jamais compté comme aujourd'hui.
  a("t-f", D(-1), ws("w-yesterday", "Hier", 40, 1)),
  // Futur
  a("t-a", D(5), ws("w-a5", "A J+5", 1, 1)),
  a("t-a", D(2), ws("w-a2", "A J+2", 1, 1)),
  a("t-b", D(1), ws("w-b1", "B J+1", 1, 1)),
  a("t-c", D(3), ws("w-c3", "C J+3", 1, 1), "PENDING"),
  a("t-c", D(4), ws("w-c4", "C J+4", 1, 1)),
  a("t-d", D(7), ws("w-d7", "D J+7", 1, 1)),
  a("t-e", D(1), ws("w-e1", "E J+1", 1, 1), "REFUSED"),
  a("t-arch", D(1), ws("w-arch1", "Arch J+1", 1, 1)),
  a("t-x", D(1), ws("w-x1", "X J+1", 1, 1, OTHER)),
  a("t-f", D(1), ws("w-f1", "F étranger J+1", 1, 1, OTHER)),
]

const ITEMS = toEquipeViewItems(TEAMS, assignmentsOnDbDate(ROWS, TODAY), CO)
const CURRENT = getCurrentInterventions(ITEMS)
const MAP = buildInterventionMap(CURRENT)
const UPCOMING = getUpcomingInterventions(ROWS, ITEMS, CO, TODAY)

describe("PR B — interventions actuelles (définition exacte, Paris)", () => {
  it("équipe active + CONFIRMED aujourd'hui (Europe/Paris) uniquement", () => {
    assert.deepEqual(
      CURRENT.map((c) => [c.team.name, c.worksite.name]),
      [
        ["Alpha", "Résidence Les Pins"],
        ["Bravo", "Résidence Les Pins"],
        ["Charlie", "Chantier sans GPS"],
      ]
    )
  })

  it("PENDING, REFUSED, archivée, autre tenant, chantier étranger et veille exclus", () => {
    const names = CURRENT.map((c) => c.team.name)
    for (const excluded of ["Delta", "Echo", "Archivée", "Étrangère", "Foxtrot"]) assert.ok(!names.includes(excluded), excluded)
  })

  it("jour de référence = date civile parisienne (22:30 UTC → lendemain)", () => {
    assert.equal(TODAY.toISOString(), "2026-07-15T00:00:00.000Z")
    assert.deepEqual(assignmentsOnDbDate(ROWS, TODAY).map((r) => r.date.toISOString()).filter((d, i, l) => l.indexOf(d) === i), [
      "2026-07-15T00:00:00.000Z",
    ])
  })
})

describe("PR B — données de carte", () => {
  it("localisation = coordonnées du chantier du jour ; même chantier → un seul marqueur regroupé", () => {
    assert.equal(MAP.markers.length, 1)
    const [m] = MAP.markers
    assert.deepEqual([m.latitude, m.longitude], [48.85, 2.35])
    assert.equal(m.teamCount, 2)
    assert.deepEqual(m.sites.map((s) => [s.worksite.name, s.teams.map((t) => t.name)]), [["Résidence Les Pins", ["Alpha", "Bravo"]]])
  })

  it("chantier sans coordonnées → équipe non localisée (jamais de position inventée)", () => {
    assert.deepEqual(MAP.unlocalized.map((c) => c.team.name), ["Charlie"])
  })

  it("deux chantiers différents au même point : un marqueur, deux sections, aucun décalage", () => {
    const items = toEquipeViewItems(
      [team("t1", "Un"), team("t2", "Deux")],
      [a("t1", TODAY, ws("w1", "Lot A", 45.1, 4.2)), a("t2", TODAY, ws("w2", "Lot B", 45.1, 4.2))],
      CO
    )
    const map = buildInterventionMap(getCurrentInterventions(items))
    assert.equal(map.markers.length, 1)
    assert.deepEqual(map.markers[0].sites.map((s) => s.worksite.name).sort(), ["Lot A", "Lot B"])
    assert.deepEqual([map.markers[0].latitude, map.markers[0].longitude], [45.1, 4.2])
  })

  it("aucun chantier localisé → aucun marqueur", () => {
    const items = toEquipeViewItems([team("t1", "Un")], [a("t1", TODAY, NOCOORD)], CO)
    const map = buildInterventionMap(getCurrentInterventions(items))
    assert.equal(map.markers.length, 0)
    assert.equal(map.unlocalized.length, 1)
    assert.equal(buildInterventionMap([]).markers.length, 0)
  })

  it("coordonnées invalides refusées (null, NaN, hors bornes, 0/0)", () => {
    assert.ok(hasValidCoordinates({ latitude: 48.85, longitude: 2.35 }))
    for (const [lat, lng] of [[null, 2], [48, null], [Number.NaN, 2], [91, 2], [48, 181], [0, 0]] as const) {
      assert.ok(!hasValidCoordinates({ latitude: lat, longitude: lng }), `${lat},${lng}`)
    }
  })
})

describe("PR B — sécurité des popups Leaflet", () => {
  const evil = "<img src=x onerror=alert(1)>"
  const items = toEquipeViewItems(
    [team("t1", `Équipe ${evil}`, { color: 'red;"><script>alert(1)</script>' })],
    [a("t1", TODAY, ws("w1", `Chantier "${evil}" & 'co'`, 45, 4))],
    CO
  )
  const [marker] = buildInterventionMap(getCurrentInterventions(items)).markers

  it("nom d'équipe et nom de chantier échappés dans la popup", () => {
    const html = buildMarkerPopupHtml(marker)
    assert.ok(!html.includes("<img"), html)
    assert.ok(!html.includes("<script"), html)
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"))
    assert.ok(html.includes("Chantier &quot;&lt;img"))
    assert.ok(html.includes("&amp; &#39;co&#39;"))
  })

  it("couleur d'équipe non hexadécimale remplacée par la couleur par défaut", () => {
    assert.equal(safeTeamColor("#AbC123"), "#AbC123")
    assert.equal(safeTeamColor("#fff"), "#fff")
    assert.equal(safeTeamColor('red;"><script>'), "#0f3460")
    assert.equal(safeTeamColor(null), "#0f3460")
    assert.ok(!buildMarkerPopupHtml(marker).includes("script"))
    assert.ok(!markerIconHtml(marker).includes("script"))
  })

  it("infobulle et icône du marqueur échappées", () => {
    assert.ok(!markerTooltip(marker).includes("<img"))
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;")
  })

  it("plusieurs équipes au même point : l'icône affiche le compteur", () => {
    assert.match(markerIconHtml(MAP.markers[0]), />2<\/div>$/)
  })
})

describe("PR B — prochaines interventions", () => {
  it("prochaine intervention par équipe : future, CONFIRMED, équipe active du tenant, tri chronologique, max 3", () => {
    assert.deepEqual(
      UPCOMING.items.map((u) => [u.team.name, u.worksite.name, u.date.toISOString().slice(0, 10)]),
      [
        ["Bravo", "B J+1", "2026-07-16"],
        ["Alpha", "A J+2", "2026-07-17"], // J+2 retenu avant J+5
        ["Charlie", "C J+4", "2026-07-19"], // PENDING J+3 ignoré
      ]
    )
    assert.equal(UPCOMING.total, 4) // + Delta J+7, non affichée (limite 3)
  })

  it("aujourd'hui exclu, REFUSED / archivée / autre tenant / chantier étranger exclus", () => {
    const all = getUpcomingInterventions(ROWS, ITEMS, CO, TODAY, 99).items.map((u) => u.team.name)
    assert.deepEqual(all, ["Bravo", "Alpha", "Charlie", "Delta"])
  })

  it("aucune → liste vide", () => {
    assert.deepEqual(getUpcomingInterventions([], ITEMS, CO, TODAY), { items: [], total: 0 })
  })

  it("date affichée = date civile stockée", () => {
    assert.equal(formatDbDate(new Date("2026-07-16T00:00:00.000Z")), "jeu. 16 juil.")
  })
})

describe("PR B — actions rapides et liens (routes existantes, gardes serveur)", () => {
  it("ADMIN / SUPER_ADMIN : 4 actions dont véhicules", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"]) {
      assert.deepEqual(getQuickActions(role).map((q) => [q.id, q.href]), [
        ["newTeam", null],
        ["planning", "/planning"],
        ["worksites", "/chantiers"],
        ["vehicles", "/vehicules"],
      ])
    }
  })

  it("TEAM_LEADER : pas de /vehicules ni de /planning (gardes ADMIN/SUPER_ADMIN), calendrier à la place", () => {
    assert.deepEqual(getQuickActions("TEAM_LEADER").map((q) => [q.id, q.href]), [
      ["newTeam", null],
      ["planning", "/planning/calendrier"],
      ["worksites", "/chantiers"],
    ])
    assert.equal(getPlanningHref("TEAM_LEADER"), "/planning/calendrier")
  })

  it("autres rôles : aucune action ; jamais d'« Affectation rapide »", () => {
    assert.deepEqual(getQuickActions("EMPLOYEE"), [])
    for (const role of ["ADMIN", "SUPER_ADMIN", "TEAM_LEADER"]) {
      assert.ok(!getQuickActions(role).some((q) => /affect|assign/i.test(`${q.id} ${q.label}`)))
    }
  })

  it("chaque href correspond à une page existante", async () => {
    const { existsSync } = await import("node:fs")
    const hrefs = new Set([UPCOMING_SEE_ALL_HREF, getPlanningHref("ADMIN"), getPlanningHref("TEAM_LEADER")])
    for (const role of ["ADMIN", "TEAM_LEADER"]) for (const q of getQuickActions(role)) if (q.href) hrefs.add(q.href)
    for (const href of hrefs) {
      assert.ok(existsSync(`src/app/(dashboard)${href}/page.tsx`), href)
    }
  })
})

describe("PR B — panneau droit (rendu)", () => {
  const noop = () => {}
  const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop }
  const render = (role: string, over: Partial<Parameters<typeof EquipesSidePanel>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: router as never },
        createElement(EquipesSidePanel, {
          current: CURRENT,
          map: MAP,
          upcoming: UPCOMING,
          quickActions: getQuickActions(role),
          planningHref: getPlanningHref(role),
          employees: [],
          ...over,
        })
      )
    )
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ")

  it("exactement 4 blocs, dans l'ordre du visuel", () => {
    const html = render("ADMIN")
    assert.deepEqual([...html.matchAll(/data-panel-block="([^"]+)"/g)].map((m) => m[1]), ["repartition", "current", "upcoming", "quick"])
    const t = text(html)
    const titles = ["Répartition des équipes", "Équipes en intervention", "Prochaines interventions", "Actions rapides"]
    const positions = titles.map((x) => t.indexOf(x))
    assert.ok(positions.every((p) => p >= 0), String(positions))
    assert.deepEqual([...positions].sort((x, y) => x - y), positions)
  })

  it("légende factuelle + équipes non localisées signalées", () => {
    const t = text(render("ADMIN"))
    assert.ok(t.includes("Équipe en intervention (chantier du jour)"))
    assert.ok(t.includes("1 équipe non localisée"))
    assert.ok(!/Autres/.test(t))
  })

  it("équipes en intervention + lien planning ; prochaines interventions avec date", () => {
    const html = render("ADMIN")
    const t = text(html)
    assert.ok(t.includes("Équipes en intervention (3)"))
    assert.ok(t.includes("Voir le planning des équipes"))
    assert.ok(html.includes('href="/planning"'))
    assert.ok(t.includes("B J+1") && t.includes("jeu. 16 juil."))
    assert.ok(!t.includes("D J+7"))
    assert.ok(html.includes(`href="${UPCOMING_SEE_ALL_HREF}"`))
  })

  it("TEAM_LEADER : aucun lien vers /vehicules ni /planning", () => {
    const html = render("TEAM_LEADER")
    assert.ok(!html.includes('href="/vehicules"'))
    assert.ok(!html.includes('href="/planning"'))
    assert.ok(html.includes('href="/planning/calendrier"'))
    assert.ok(!/Affectation rapide/.test(text(html)))
  })

  it("états vides compacts", () => {
    const t = text(render("ADMIN", { current: [], map: { markers: [], unlocalized: [] }, upcoming: { items: [], total: 0 } }))
    assert.ok(t.includes("Aucune équipe en intervention aujourd'hui."))
    assert.ok(t.includes("Aucune intervention confirmée aujourd'hui."))
    assert.ok(t.includes("Aucune intervention confirmée dans les 30 prochains jours."))
  })

  it("plus de 5 équipes en intervention : 5 visibles puis « Voir tout »", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      team: { id: `m${i}`, name: `Équipe ${i}`, color: null },
      worksite: { id: `w${i}`, name: `Chantier ${i}`, latitude: null, longitude: null },
    }))
    const t = text(render("ADMIN", { current: many }))
    assert.ok(t.includes("Chantier 4") && !t.includes("Chantier 5"))
    assert.ok(t.includes("Voir tout (7)"))
  })
})

describe("PR B — cycle de vie EquipesMap", () => {
  // Pas de DOM (jsdom non installé) : les effets Leaflet ne s'exécutent pas en SSR.
  // Garde-fou statique : le cleanup doit remettre `ready` à false, sinon un remount / hot reload
  // peut laisser une carte sans marqueurs (l'effet des marqueurs ne se relancerait pas).
  it("le cleanup de l'initialisation remet ready à false", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/components/equipes/EquipesMap.tsx", "utf8")
    const cleanup = src.slice(src.indexOf("return () => {"), src.indexOf("}, [])"))
    assert.match(cleanup, /leafletRef\.current = null/)
    assert.match(cleanup, /setReady\(false\)/)
  })
})

describe("PR B — disposition desktop (panneau à droite)", () => {
  // La page est un composant serveur (Prisma) : garde-fou statique sur les classes de grille.
  // Géométrie : sidebar w-64 (256 px) + padding main md:p-6 (48 px) ; carte = border 2 + p-4 (32).
  // Pied de carte le plus large : 4 avatars + « +N » (108) + gap 8 + repère w-32 (128) = 244 px.
  const MEASURED_VIEWPORT = 1175
  const SIDEBAR = 256
  const MAIN_PADDING = 48
  const CLASSIC_SCROLLBAR = 15
  const MOSAIC_GAP = 16
  const CARD_CHROME = 2 + 32
  const CARD_FOOTER_MIN = 244

  const read = async (p: string) => (await import("node:fs")).readFileSync(p, "utf8")

  async function geometry() {
    const page = await read("src/app/(dashboard)/equipes/page.tsx")
    const m = page.match(/min-\[(\d+)px\]:grid-cols-\[minmax\(0,1fr\)_(\d+)px\]/)
    assert.ok(m, "grille principale à deux colonnes introuvable")
    const breakpoint = Number(m[1])
    const panel = Number(m[2])
    const gapMatch = page.match(new RegExp(`min-\\[${breakpoint}px\\]:gap-(\\d+)`))
    assert.ok(gapMatch, "gap principal introuvable")
    return { page, breakpoint, panel, gap: Number(gapMatch[1]) * 4 }
  }

  it("1. le panneau passe à droite au plus tard à 1175 px (largeur mesurée)", async () => {
    const { page, breakpoint } = await geometry()
    assert.ok(breakpoint <= MEASURED_VIEWPORT, `seuil ${breakpoint}px > ${MEASURED_VIEWPORT}px`)
    assert.doesNotMatch(page, /\bxl:grid-cols-\[minmax/)
  })

  it("2. largeur du panneau compatible : 2 cartes complètes au seuil, même avec une barre de défilement classique", async () => {
    const { breakpoint, panel, gap } = await geometry()
    assert.ok(panel >= 240 && panel <= 280, `panneau ${panel}px`)
    for (const scrollbar of [0, CLASSIC_SCROLLBAR]) {
      const main = breakpoint - SIDEBAR - MAIN_PADDING - scrollbar - panel - gap
      const card = (main - MOSAIC_GAP) / 2
      assert.ok(card - CARD_CHROME >= CARD_FOOTER_MIN, `carte ${card}px trop étroite (scrollbar ${scrollbar})`)
    }
  })

  it("3. Mosaïque à 2 colonnes à 1175 px ; KPI en 2×2 sur la plage du panneau", async () => {
    const { breakpoint } = await geometry()
    const view = await read("src/components/equipes/EquipesView.tsx")
    assert.match(view, /grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3 min-\[1800px\]:grid-cols-4/)
    const stats = await read("src/components/equipes/EquipeStats.tsx")
    assert.ok(stats.includes(`lg:grid-cols-4 min-[${breakpoint}px]:grid-cols-2 2xl:grid-cols-4`), "KPI non alignés sur le seuil du panneau")
  })

  it("onglets resserrés sur la seule plage du panneau (5 onglets visibles à 1175 px), espacement d'origine dès 2xl", async () => {
    const { breakpoint } = await geometry()
    const toolbar = await read("src/components/equipes/EquipesToolbar.tsx")
    assert.ok(toolbar.includes(`px-3 py-2 min-[${breakpoint}px]:px-2 2xl:px-3`))
    assert.ok(toolbar.includes(`gap-1 overflow-x-auto border-b border-slate-200 min-[${breakpoint}px]:gap-0.5 2xl:gap-1`))
  })

  it("4. aucune règle contradictoire ne repasse à une colonne entre le seuil et 1536 px", async () => {
    const { page } = await geometry()
    const view = await read("src/components/equipes/EquipesView.tsx")
    const stats = await read("src/components/equipes/EquipeStats.tsx")
    for (const src of [page, view, stats]) {
      assert.doesNotMatch(src, /\b(md|lg|xl|min-\[\d+px\]):grid-cols-1\b/)
      assert.doesNotMatch(src, /\b(lg|xl|min-\[\d+px\]):(block|flex-col)\b/)
    }
  })
})
