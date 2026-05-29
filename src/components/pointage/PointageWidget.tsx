"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { MapPin, LogIn, LogOut, Loader2, Navigation } from "lucide-react"
import { Button } from "@/components/ui/button"
import { clockIn, clockOut } from "@/lib/actions/timeclock.actions"

interface Timeclock {
  checkInAt:   Date | null
  checkOutAt:  Date | null
  checkInLat:  number | null
  checkInLng:  number | null
  checkOutLat: number | null
  checkOutLng: number | null
  worksite:    { name: string } | null
}

interface Props {
  today: Timeclock | null
  worksites: { id: string; name: string }[]
}

function fmt(d: Date | null) {
  if (!d) return "—"
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(d))
}

function duration(checkIn: Date, checkOut: Date) {
  const ms = new Date(checkOut).getTime() - new Date(checkIn).getTime()
  const h  = Math.floor(ms / 3600000)
  const m  = Math.floor((ms % 3600000) / 60000)
  return `${h}h${m.toString().padStart(2, "0")}`
}

export function PointageWidget({ today, worksites }: Props) {
  const router              = useRouter()
  const [loading, setLoading] = useState(false)
  const [geoError, setGeoError] = useState<string | null>(null)
  const [selectedWorksiteId, setSelectedWorksiteId] = useState<string>("")

  const hasCheckedIn  = !!today?.checkInAt
  const hasCheckedOut = !!today?.checkOutAt

  function getPosition(): Promise<GeolocationPosition> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("La géolocalisation n'est pas supportée par votre navigateur."))
        return
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      })
    })
  }

  async function handleClockIn() {
    setLoading(true)
    setGeoError(null)
    try {
      const pos    = await getPosition()
      const { latitude, longitude } = pos.coords
      const result = await clockIn(latitude, longitude, selectedWorksiteId || undefined)
      if (result?.error) { toast.error(result.error); return }
      toast.success("Arrivée pointée ✓")
      router.refresh()
    } catch (err) {
      const msg = err instanceof GeolocationPositionError
        ? err.code === 1 ? "Accès à la localisation refusé. Autorisez-la dans les paramètres." : "Position introuvable. Réessayez."
        : "Erreur de géolocalisation."
      setGeoError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleClockOut() {
    setLoading(true)
    setGeoError(null)
    try {
      const pos    = await getPosition()
      const { latitude, longitude } = pos.coords
      const result = await clockOut(latitude, longitude)
      if (result?.error) { toast.error(result.error); return }
      toast.success("Départ pointé ✓")
      router.refresh()
    } catch (err) {
      const msg = err instanceof GeolocationPositionError
        ? err.code === 1 ? "Accès à la localisation refusé. Autorisez-la dans les paramètres." : "Position introuvable. Réessayez."
        : "Erreur de géolocalisation."
      setGeoError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  // État : pas de pointage du jour
  if (!today || !hasCheckedIn) {
    return (
      <div className="space-y-4">
        {/* Sélecteur de chantier optionnel */}
        {worksites.length > 0 && (
          <div className="space-y-1.5">
            <label className="text-xs text-slate-500 font-medium">Chantier du jour (optionnel)</label>
            <select
              value={selectedWorksiteId}
              onChange={(e) => setSelectedWorksiteId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">— Sélectionner un chantier —</option>
              {worksites.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        )}

        <Button
          onClick={handleClockIn}
          disabled={loading}
          className="w-full h-14 text-base font-semibold bg-green-600 hover:bg-green-700 text-white gap-2"
        >
          {loading ? (
            <><Loader2 className="h-5 w-5 animate-spin" /> Localisation…</>
          ) : (
            <><LogIn className="h-5 w-5" /> Pointer mon arrivée</>
          )}
        </Button>

        {geoError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg p-3">
            <Navigation className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-xs text-red-600">{geoError}</p>
          </div>
        )}

        <p className="text-xs text-slate-400 text-center flex items-center justify-center gap-1">
          <MapPin className="h-3 w-3" /> Votre position GPS sera enregistrée
        </p>
      </div>
    )
  }

  // État : arrivée pointée, départ pas encore fait
  if (hasCheckedIn && !hasCheckedOut) {
    return (
      <div className="space-y-4">
        {/* Récap arrivée */}
        <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center shrink-0">
            <LogIn className="h-5 w-5 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-green-800">Arrivée pointée</p>
            <p className="text-xs text-green-600">
              {fmt(today.checkInAt)} {today.worksite ? `· ${today.worksite.name}` : ""}
            </p>
            {today.checkInLat && (
              <a
                href={`https://www.google.com/maps?q=${today.checkInLat},${today.checkInLng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-green-500 hover:underline flex items-center gap-0.5 mt-0.5"
              >
                <MapPin className="h-3 w-3" /> Voir sur la carte
              </a>
            )}
          </div>
        </div>

        <Button
          onClick={handleClockOut}
          disabled={loading}
          className="w-full h-14 text-base font-semibold bg-[#0f3460] hover:bg-[#0f3460]/90 text-white gap-2"
        >
          {loading ? (
            <><Loader2 className="h-5 w-5 animate-spin" /> Localisation…</>
          ) : (
            <><LogOut className="h-5 w-5" /> Pointer mon départ</>
          )}
        </Button>

        {geoError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg p-3">
            <Navigation className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-xs text-red-600">{geoError}</p>
          </div>
        )}
      </div>
    )
  }

  // État : journée complète
  return (
    <div className="space-y-3">
      <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center shrink-0">
          <LogIn className="h-5 w-5 text-green-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-green-800">Arrivée</p>
          <p className="text-xs text-green-600">{fmt(today.checkInAt)} {today.worksite ? `· ${today.worksite.name}` : ""}</p>
        </div>
      </div>

      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
          <LogOut className="h-5 w-5 text-slate-500" />
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-800">Départ</p>
          <p className="text-xs text-slate-500">{fmt(today.checkOutAt)}</p>
        </div>
      </div>

      {today.checkInAt && today.checkOutAt && (
        <div className="text-center">
          <span className="text-xs font-medium text-slate-500">Durée totale : </span>
          <span className="text-xs font-bold text-slate-800">{duration(today.checkInAt, today.checkOutAt)}</span>
        </div>
      )}

      <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-center">
        <p className="text-sm font-medium text-blue-700">Journée terminée ✓</p>
        <p className="text-xs text-blue-500 mt-0.5">Vos pointages ont été enregistrés.</p>
      </div>
    </div>
  )
}
