"use client"

import { useEffect, useRef } from "react"
import { MapPin } from "lucide-react"

interface PointageEntry {
  id:          string
  checkInAt:   Date | null
  checkInLat:  number | null
  checkInLng:  number | null
  checkOutAt:  Date | null
  checkOutLat: number | null
  checkOutLng: number | null
  employee:    { firstName: string; lastName: string }
  worksite:    { name: string } | null
}

interface Props {
  pointages: PointageEntry[]
}

function fmt(d: Date | null) {
  if (!d) return "—"
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(d))
}

export function PointagesMap({ pointages }: Props) {
  const mapRef         = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)

  const withIn  = pointages.filter((p) => p.checkInLat && p.checkInLng)
  const withOut = pointages.filter((p) => p.checkOutLat && p.checkOutLng)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    import("leaflet").then((L) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (L.Icon.Default.prototype as any)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      })

      const map = L.map(mapRef.current!).setView([46.8566, 2.3522], 6)
      mapInstanceRef.current = map

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      const bounds: [number, number][] = []

      // Marqueurs d'arrivée (vert)
      withIn.forEach((p) => {
        const icon = L.divIcon({
          html: `<div style="
            background:#22c55e;width:28px;height:28px;
            border-radius:50% 50% 50% 0;transform:rotate(-45deg);
            border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [28, 28], iconAnchor: [14, 28], className: "",
        })

        const popup = L.popup().setContent(`
          <div style="min-width:160px;font-family:sans-serif;">
            <p style="font-weight:600;font-size:13px;margin:0 0 2px">${p.employee.firstName} ${p.employee.lastName}</p>
            ${p.worksite ? `<p style="color:#6b7280;font-size:12px;margin:0 0 4px">${p.worksite.name}</p>` : ""}
            <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:9999px;font-size:11px;">Arrivée ${fmt(p.checkInAt)}</span>
          </div>
        `)

        L.marker([p.checkInLat!, p.checkInLng!], { icon }).addTo(map).bindPopup(popup)
        bounds.push([p.checkInLat!, p.checkInLng!])
      })

      // Marqueurs de départ (bleu)
      withOut.forEach((p) => {
        const icon = L.divIcon({
          html: `<div style="
            background:#3b82f6;width:22px;height:22px;
            border-radius:50% 50% 50% 0;transform:rotate(-45deg);
            border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);
          "></div>`,
          iconSize: [22, 22], iconAnchor: [11, 22], className: "",
        })

        const popup = L.popup().setContent(`
          <div style="min-width:160px;font-family:sans-serif;">
            <p style="font-weight:600;font-size:13px;margin:0 0 2px">${p.employee.firstName} ${p.employee.lastName}</p>
            <span style="background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:9999px;font-size:11px;">Départ ${fmt(p.checkOutAt)}</span>
          </div>
        `)

        L.marker([p.checkOutLat!, p.checkOutLng!], { icon }).addTo(map).bindPopup(popup)
        bounds.push([p.checkOutLat!, p.checkOutLng!])
      })

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

  if (withIn.length === 0 && withOut.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200">
        <MapPin className="h-8 w-8 text-slate-300 mb-2" />
        <p className="text-sm text-slate-400">Aucun pointage géolocalisé pour cette période</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-4">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-xs text-slate-500">Arrivée</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-blue-500" />
          <span className="text-xs text-slate-500">Départ</span>
        </div>
      </div>
      <div ref={mapRef} className="h-[400px] rounded-xl overflow-hidden border border-slate-200 z-0" />
    </div>
  )
}
