// VEHICLES V1C — rendu statique de la page Véhicules et du formulaire partagé (aucune DB).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { VehiculesView } from "@/components/vehicules/VehiculesView"
import { VehiculesStats } from "@/components/vehicules/VehiculesStats"
import { VehicleForm } from "@/components/vehicules/VehicleForm"
import { VehicleHistory } from "@/components/vehicules/VehicleHistory"
import { VehiculeCard } from "@/components/vehicules/VehiculeCard"
import { TruckSelector } from "@/components/equipes/TruckSelector"
import type { VehicleViewItem } from "@/lib/vehicules/vehicules-view"

// tsconfig "jsx": "preserve" → sous tsx, runtime JSX classique.
;(globalThis as { React?: typeof React }).React = React

const noop = () => {}
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop }

const TEAMS = [{ id: "team-1", name: "Équipe Nord" }] // équipes ACTIVES
const EMPLOYEES = [{ id: "emp-1", firstName: "Hélène", lastName: "Dupont" }] // employés ACTIFS

const v = (over: Partial<VehicleViewItem> & { id: string; matricule: string }): VehicleViewItem => ({
  marque: null,
  modele: null,
  active: true,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  team: null,
  chauffeur: null,
  history: [],
  historyTruncated: false,
  ...over,
})

const TRUCKS: VehicleViewItem[] = [
  v({ id: "a", matricule: "AB-123-CD", marque: "Volkswagen", modele: "Crafter", team: { id: "team-1", name: "Équipe Nord", color: "#123456" }, chauffeur: { id: "emp-1", firstName: "Hélène", lastName: "Dupont" } }),
  v({ id: "b", matricule: "EF-456-GH", marque: "VW Crafter" }), // legacy : marque seule
  v({ id: "c", matricule: "IJ-789-KL" }), // aucune identité
  v({ id: "e", matricule: "QR-345-ST", marque: "Renault", modele: "Trafic", active: false, archivedAt: "2026-06-01T00:00:00.000Z" }),
]

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, el))

const view = (trucks = TRUCKS) => render(createElement(VehiculesView, { trucks, teams: TEAMS, employees: EMPLOYEES }))

describe("VehiculesView — mosaïque (défaut)", () => {
  const html = view()
  it("en-tête, bouton, KPIs", () => {
    assert.match(html, /<h1[^>]*>Véhicules<\/h1>/)
    assert.match(html, /Nouveau véhicule/)
    for (const label of ["Total", "Actifs", "Affectés", "Sans équipe", "Archivés"]) assert.match(html, new RegExp(`<dt[^>]*>${label}</dt>`))
  })
  it("onglets avec compteurs (Actifs 3, Archivés 1, Tous 4)", () => {
    assert.match(html, /Actifs<span[^>]*>3<\/span>/)
    assert.match(html, /Archivés<span[^>]*>1<\/span>/)
    assert.match(html, /Tous<span[^>]*>4<\/span>/)
  })
  it("filtre d'affectation : libellé visible « Affectation », options Toutes / Affectés / Non affectés, sans ambiguïté avec les onglets", () => {
    assert.match(html, /Affectation\s*<select aria-label="Filtrer par affectation"/)
    assert.match(html, /<option value="all" selected="">Toutes<\/option>/)
    assert.match(html, /<option value="assigned">Affectés<\/option>/)
    assert.match(html, /<option value="unassigned">Non affectés<\/option>/)
    assert.doesNotMatch(html, /Tous les statuts/)
  })
  it("recherche, filtres, tri, modes", () => {
    assert.match(html, /aria-label="Rechercher un véhicule"/)
    assert.match(html, /aria-label="Filtrer par équipe"/)
    assert.match(html, /aria-label="Filtrer par chauffeur"/)
    assert.match(html, /aria-label="Filtrer par affectation"/)
    assert.doesNotMatch(html, /statut/i)
    assert.match(html, /aria-label="Trier par"/)
    assert.match(html, /aria-label="Mosaïque"[^>]*/)
    assert.match(html, /aria-label="Liste"/)
  })
  it("identité : marque + modèle, legacy inchangée, repli", () => {
    assert.match(html, /Volkswagen Crafter/)
    assert.match(html, />VW Crafter</)
    assert.match(html, /Marque et modèle non renseignés/)
    assert.doesNotMatch(html, /Marque non renseignée/)
  })
  it("onglet Actifs : l'archivé n'est pas listé", () => {
    assert.doesNotMatch(html, /QR-345-ST/)
  })
  it("actions conservées : historique, modifier, archiver ; jamais de suppression", () => {
    assert.match(html, /aria-label="Historique du véhicule AB-123-CD"/)
    assert.match(html, /aria-label="Modifier le véhicule AB-123-CD"/)
    assert.match(html, /aria-label="Archiver le véhicule AB-123-CD"/)
    assert.doesNotMatch(html, /Supprimer/)
  })
  it("sélecteurs d'affectation valorisés", () => {
    assert.match(html, /<option value="team-1" selected="">Équipe Nord<\/option>/)
    assert.match(html, /<option value="emp-1" selected="">Hélène Dupont<\/option>/)
  })
  it("l'ancien champ unique « Marque / modèle (ex: VW Crafter) » n'apparaît plus", () => {
    assert.doesNotMatch(html, /Marque \/ modèle \(ex/)
  })
})

describe("VehiculesView — états vides", () => {
  it("aucun véhicule : état vide, pas de KPIs ni de barre d'outils", () => {
    const html = view([])
    assert.match(html, /Aucun véhicule pour le moment/)
    assert.doesNotMatch(html, /<dt/)
    assert.doesNotMatch(html, /Rechercher un véhicule/)
  })
  it("uniquement archivés : onglet Actifs vide", () => {
    const html = view([TRUCKS[3]])
    assert.match(html, /Aucun véhicule actif\./)
  })
})

describe("VehiculeCard — layouts et cas legacy", () => {
  const base = { teams: TEAMS, employees: EMPLOYEES, loading: false, historyOpen: false, onToggleHistory: noop, onEdit: noop, onArchive: noop, onRestore: noop, onAssign: noop }
  const card = (truck: VehicleViewItem, over: Partial<React.ComponentProps<typeof VehiculeCard>> = {}) =>
    render(createElement(VehiculeCard, { truck, layout: "grid", ...base, ...over }))

  it("liste : même contenu, mise en page en ligne", () => {
    const html = card(TRUCKS[0], { layout: "list" })
    assert.match(html, /lg:flex-row/)
    assert.match(html, /AB-123-CD/)
    assert.match(html, /Volkswagen Crafter/)
    assert.doesNotMatch(card(TRUCKS[0], { layout: "grid" }), /lg:flex-row/)
  })
  it("chauffeur legacy inactif : option « (inactif) » conservée", () => {
    const truck = v({ id: "x", matricule: "LG-001", chauffeur: { id: "emp-old", firstName: "Paul", lastName: "Ancien" } })
    const html = card(truck)
    assert.match(html, /<option value="emp-old" selected="">Paul Ancien \(inactif\)<\/option>/)
  })
  it("équipe legacy archivée : option « (archivée) » conservée et badge", () => {
    const truck = v({ id: "x", matricule: "LG-002", team: { id: "team-old", name: "Vieille équipe", color: null } })
    const html = card(truck)
    assert.match(html, /<option value="team-old" selected="">Vieille équipe \(archivée\)<\/option>/)
    assert.match(html, /Vieille équipe \(archivée\)/)
  })
  it("véhicule archivé : statut, restauration, aucune affectation possible (aucun sélecteur)", () => {
    const html = card(TRUCKS[3])
    assert.match(html, /Archivé/)
    assert.match(html, /Restaurer/)
    assert.match(html, /Renault Trafic/)
    assert.match(html, /archivé le/)
    assert.doesNotMatch(html, /<select/)
    assert.doesNotMatch(html, /Archiver le véhicule/)
  })
  it("badge : chauffeur seul → « Affecté » ; ni équipe ni chauffeur → « Non affecté » ; équipe → son nom", () => {
    const driver = { id: "emp-1", firstName: "Hélène", lastName: "Dupont" }
    assert.match(card(v({ id: "x", matricule: "CH-001", chauffeur: driver })), />Affecté</)
    assert.doesNotMatch(card(v({ id: "x", matricule: "CH-001", chauffeur: driver })), /Non affecté/)
    assert.match(card(v({ id: "y", matricule: "NO-001" })), />Non affecté</)
    assert.match(card(TRUCKS[0]), />Équipe Nord</)
  })
  it("archivé : badge « Archivé », jamais « Affecté »", () => {
    const html = card(v({ id: "z", matricule: "AR-001", active: false, archivedAt: "2026-06-01T00:00:00.000Z" }))
    assert.match(html, />Archivé</)
    assert.doesNotMatch(html, />Affecté</)
  })
  it("historique ouvert : affiché dans la carte (actif et archivé)", () => {
    const truck = v({ id: "h", matricule: "HI-001", history: [{ id: "p1", chauffeurName: "Hélène Dupont", teamName: "Équipe Nord", reason: "CREATED", startedAt: "2026-01-01T10:00:00.000Z", endedAt: null }] })
    assert.match(card(truck, { historyOpen: true }), /Historique des affectations/)
    assert.match(card({ ...truck, active: false, archivedAt: "2026-06-01T00:00:00.000Z" }, { historyOpen: true }), /Hélène Dupont/)
  })
})

describe("VehicleHistory — motifs et troncature", () => {
  const entry = (id: string, reason: string | null, endedAt: string | null = "2026-02-01T00:00:00.000Z") => ({
    id, chauffeurName: null, teamName: null, reason, startedAt: "2026-01-01T00:00:00.000Z", endedAt,
  })
  it("motif lisible pour chaque raison, jamais le nom technique", () => {
    const html = render(createElement(VehicleHistory, {
      entries: ["CREATED", "REASSIGNED", "DISPLACED", "ARCHIVED", "RESTORED", "BACKFILL"].map((r, i) => entry(`p${i}`, r)),
      truncated: false,
    }))
    for (const label of ["Création", "Réaffectation", "Déplacement", "Archivage", "Restauration", "Historique initial"]) assert.match(html, new RegExp(`>${label}<`))
    for (const raw of ["CREATED", "REASSIGNED", "DISPLACED", "ARCHIVED", "RESTORED", "BACKFILL"]) assert.doesNotMatch(html, new RegExp(raw))
  })
  it("période en cours : badge « Actuel »", () => {
    assert.match(render(createElement(VehicleHistory, { entries: [entry("p", "CREATED", null)], truncated: false })), /Actuel/)
  })
  it("troncature : indication affichée uniquement lorsque des périodes plus anciennes existent", () => {
    const e = [entry("p", "CREATED")]
    assert.match(render(createElement(VehicleHistory, { entries: e, truncated: true })), /20 dernières périodes affichées/)
    assert.doesNotMatch(render(createElement(VehicleHistory, { entries: e, truncated: false })), /dernières périodes affichées/)
  })
  it("historique vide : message dédié", () => {
    assert.match(render(createElement(VehicleHistory, { entries: [], truncated: false })), /Aucun historique pour le moment/)
  })
})

describe("VehicleForm — formulaire partagé", () => {
  const form = (props: Partial<React.ComponentProps<typeof VehicleForm>> = {}) =>
    render(createElement(VehicleForm, { submitLabel: "Ajouter", onSubmit: noop, onCancel: noop, ...props }))
  it("trois champs : Immatriculation, Marque, Modèle ; plus de « Marque / modèle »", () => {
    const html = form()
    for (const label of ["Immatriculation", "Marque", "Modèle"]) assert.match(html, new RegExp(`>${label}</label>`))
    assert.doesNotMatch(html, /Marque \/ modèle/)
    assert.match(html, /maxLength="100"/)
  })
  it("modification : valeurs initiales ; une marque legacy reste intacte dans « Marque »", () => {
    const html = form({ initialValues: { matricule: "AB-1", marque: "VW Crafter", modele: "" }, submitLabel: "Enregistrer" })
    assert.match(html, /value="VW Crafter"/)
    assert.match(html, /Enregistrer/)
  })
  it("création : bouton désactivé sans immatriculation", () => {
    assert.match(form(), /type="submit" disabled=""/)
  })
  it("ids uniques par préfixe (plusieurs formulaires sur une page)", () => {
    assert.match(form({ idPrefix: "team-1-add" }), /id="team-1-add-matricule"/)
  })
})

describe("VehiculesStats", () => {
  it("affiche les cinq indicateurs", () => {
    const html = render(createElement(VehiculesStats, { stats: { total: 5, active: 4, assigned: 3, withoutTeam: 2, archived: 1 } }))
    assert.match(html, /<dd[^>]*>5<\/dd>/)
    assert.match(html, /<dd[^>]*>1<\/dd>/)
  })
})

describe("TruckSelector (Équipes) — identité et formulaire partagé", () => {
  const truck = (over: Record<string, unknown>) => ({ id: "t", matricule: "AB-123-CD", marque: null, modele: null, chauffeurId: null, teamId: "team-1", teamName: "Équipe Nord", ...over })
  const sel = (allTrucks: ReturnType<typeof truck>[], currentTruck: ReturnType<typeof truck> | null = allTrucks[0] ?? null) =>
    render(createElement(TruckSelector, { teamId: "team-1", currentTruck, allTrucks, members: [{ id: "emp-1", name: "Hélène Dupont" }] }))

  it("libellés : marque + modèle, legacy marque seule, matricule seul", () => {
    const html = sel([
      truck({ id: "1", marque: "Volkswagen", modele: "Crafter" }),
      truck({ id: "2", matricule: "EF-456-GH", marque: "VW Crafter", teamId: null }),
      truck({ id: "3", matricule: "IJ-789-KL", teamId: null }),
    ])
    assert.match(html, />AB-123-CD — Volkswagen Crafter</)
    assert.match(html, />EF-456-GH — VW Crafter</)
    assert.match(html, />IJ-789-KL</)
  })
  it("véhicule d'une autre équipe : mention conservée", () => {
    assert.match(sel([truck({ id: "1", teamId: "team-2", teamName: "Autre" })], null), /AB-123-CD \(équipe Autre\)/)
  })
  it("plus aucun champ « Marque / modèle » dupliqué ; le formulaire partagé est utilisé", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/components/equipes/TruckSelector.tsx", "utf8")
    assert.match(src, /<VehicleForm/)
    assert.doesNotMatch(src, /Marque \/ modèle/)
    assert.doesNotMatch(src, /placeholder=/)
    assert.match(src, /toTruckPayload\(values\)/)
  })
  it("règles d'affectation conservées (erreurs serveur remontées, chauffeur courant inactif réaffiché)", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("src/components/equipes/TruckSelector.tsx", "utf8")
    assert.match(src, /reportFailure\(await patchTruck\(/)
    assert.match(src, /if \(await assign\(truck\.id\)\) toast\.success\("Camion ajouté"\)/)
    assert.match(src, /toast\.error\(err\.error \?\? "Erreur"\)/)
  })
})
