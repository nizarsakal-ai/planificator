"use client"

import { useEffect, useRef } from "react"
import { MapPin } from "lucide-react"

interface Chantier {
  id: string
  name: string
  address: string | null
  status: string
  latitude: number | null
  longitude: number | null
  client: { name: string }
}

interface ChantiersMapProps {
  chantiers: Chantier[]
}

const statusColors: Record<string, string> = {
  PLANNED:     "#3b82f6", // bleu
  IN_PROGRESS: "#22c55e", // vert
  EXTENDED:    "#f59e0b", // orange
  COMPLETED:   "#6b7280", // gris
  ARCHIVED:    "#374151", // gris foncé
}

const statusLabels: Record<string, string> = {
  PLANNED:     "Planifié",
  IN_PROGRESS: "En cours",
  EXTENDED:    "Prolongé",
  COMPLETED:   "Terminé",
  ARCHIVED:    "Archivé",
}

export function ChantiersMap({ chantiers }: ChantiersMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)

  const withCoords = chantiers.filter((c) => c.latitude && c.longitude)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    // Import dynamique de Leaflet (côté client uniquement)
    import("leaflet").then((L) => {
      // Fix icônes Leaflet avec webpack
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      })

      const map = L.map(mapRef.current!).setView([46.8566, 2.3522], 6) // Centre France
      mapInstanceRef.current = map

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      const bounds: [number, number][] = []

      withCoords.forEach((chantier) => {
        const color = statusColors[chantier.status] ?? "#3b82f6"

        // Marqueur coloré personnalisé
        const icon = L.divIcon({
          html: `<div style="
            background:${color};
            width:28px;height:28px;
            border-radius:50% 50% 50% 0;
            transform:rotate(-45deg);
            border:2px solid white;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 28],
          className: "",
        })

        const popup = L.popup().setContent(`
          <div style="min-width:160px;font-family:sans-serif;">
            <p style="font-weight:600;font-size:14px;margin:0 0 4px">${chantier.name}</p>
            <p style="color:#6b7280;font-size:12px;margin:0 0 2px">${chantier.client.name}</p>
            ${chantier.address ? `<p style="color:#6b7280;font-size:12px;margin:0 0 6px">${chantier.address}</p>` : ""}
            <span style="
              background:${color};color:white;
              padding:2px 8px;border-radius:9999px;
              font-size:11px;font-weight:500;
            ">${statusLabels[chantier.status] ?? chantier.status}</span>
            <br/><a href="/chantiers/${chantier.id}" style="color:#0f3460;font-size:12px;margin-top:6px;display:inline-block;">
              Voir le chantier →
            </a>
          </div>
        `)

        L.marker([chantier.latitude!, chantier.longitude!], { icon })
          .addTo(map)
          .bindPopup(popup)

        bounds.push([chantier.latitude!, chantier.longitude!])
      })

      // Zoomer pour afficher tous les marqueurs
      if (bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40] })
      }
    })

    return () => {
      if (mapInstanceRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(mapInstanceRef.current as any).remove()
        mapInstanceRef.current = null
      }
    }
  }, [])

  if (withCoords.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200">
        <MapPin className="h-10 w-10 text-slate-300 mb-3" />
        <p className="text-sm text-slate-500">Aucun chantier géolocalisé</p>
        <p className="text-xs text-slate-400 mt-1">Ajoutez une adresse à vos chantiers pour les voir sur la carte</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Légende */}
      <div className="flex flex-wrap gap-3">
        {Object.entries(statusLabels).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full" style={{ background: statusColors[key] }} />
            <span className="text-xs text-slate-500">{label}</span>
          </div>
        ))}
      </div>

      {/* Carte */}
      <div ref={mapRef} className="h-[500px] rounded-xl overflow-hidden border border-slate-200 z-0" />

      <p className="text-xs text-slate-400 text-right">
        {withCoords.length} chantier{withCoords.length > 1 ? "s" : ""} affiché{withCoords.length > 1 ? "s" : ""}
        {chantiers.length > withCoords.length && ` · ${chantiers.length - withCoords.length} sans coordonnées`}
      </p>
    </div>
  )
}
