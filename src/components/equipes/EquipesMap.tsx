"use client"

import { useEffect, useRef, useState } from "react"
import type { LayerGroup, Map as LeafletMap } from "leaflet"
import {
  buildMarkerPopupHtml,
  escapeHtml,
  INTERVENTION_MARKER_COLOR,
  safeTeamColor,
  type InterventionMarker,
} from "@/lib/equipes/equipes-view"

type LeafletModule = typeof import("leaflet")

export function markerIconHtml(marker: InterventionMarker): string {
  // Un seul point = couleur de l'équipe (validée) ; plusieurs équipes au même point = compteur.
  const single = marker.teamCount === 1 ? marker.sites[0].teams[0] : null
  const background = single ? safeTeamColor(single.color) : INTERVENTION_MARKER_COLOR
  const label = single ? "" : String(marker.teamCount)
  return (
    `<div style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:9999px;` +
    `background:${background};border:2px solid #fff;box-shadow:0 0 0 2px ${INTERVENTION_MARKER_COLOR},0 1px 4px rgba(0,0,0,.3);` +
    `color:#fff;font:600 10px/1 system-ui,sans-serif">${label}</div>`
  )
}

export function markerTooltip(marker: InterventionMarker): string {
  const names = marker.sites.flatMap((s) => s.teams.map((t) => t.name))
  return escapeHtml(names.length === 1 ? names[0] : `${names.length} équipes`)
}

/**
 * Carte compacte des équipes en intervention (OpenStreetMap / Leaflet, client uniquement).
 * Positions = coordonnées des chantiers CONFIRMED du jour, sans décalage ni géocodage.
 * Tout texte injecté dans le HTML Leaflet est échappé.
 */
export function EquipesMap({ markers }: { markers: InterventionMarker[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<{ L: LeafletModule; map: LeafletMap; layer: LayerGroup } | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let observer: ResizeObserver | null = null
    import("leaflet").then((L) => {
      if (cancelled || !containerRef.current || leafletRef.current) return
      const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView([46.8566, 2.3522], 5)
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)
      const layer = L.layerGroup().addTo(map)
      leafletRef.current = { L, map, layer }
      // Le panneau change de largeur (passage sous le contenu, ouverture du menu) : recalcul des tuiles.
      observer = new ResizeObserver(() => map.invalidateSize())
      observer.observe(containerRef.current)
      setReady(true)
    })
    return () => {
      cancelled = true
      observer?.disconnect()
      leafletRef.current?.map.remove()
      leafletRef.current = null
      // Remount / hot reload : la nouvelle carte repassera ready à true et redessinera les marqueurs.
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const current = leafletRef.current
    if (!ready || !current) return
    const { L, map, layer } = current
    layer.clearLayers()
    for (const m of markers) {
      const icon = L.divIcon({ html: markerIconHtml(m), className: "", iconSize: [22, 22], iconAnchor: [11, 11] })
      L.marker([m.latitude, m.longitude], { icon })
        .bindTooltip(markerTooltip(m), { direction: "top", offset: [0, -12] })
        .bindPopup(buildMarkerPopupHtml(m), { maxWidth: 220 })
        .addTo(layer)
    }
    if (markers.length === 1) map.setView([markers[0].latitude, markers[0].longitude], 12)
    else if (markers.length > 1) map.fitBounds(markers.map((m) => [m.latitude, m.longitude] as [number, number]), { padding: [24, 24] })
  }, [ready, markers])

  return (
    <div
      ref={containerRef}
      className="relative isolate z-0 h-44 overflow-hidden rounded-lg border border-slate-100"
      role="region"
      aria-label="Carte des équipes en intervention"
    />
  )
}
