"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { updateChantierStatus, prolongerChantier, decalerChantier } from "@/lib/actions/chantier.actions"

interface Props {
  worksiteId: string
  currentStatus: string
  endDate: Date
}

export function ChantierStatusActions({ worksiteId, currentStatus, endDate }: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [showProlonger, setShowProlonger] = useState(false)
  const [showDecaler, setShowDecaler] = useState(false)
  const [newEndDate, setNewEndDate] = useState("")
  const [reason, setReason] = useState("")
  const [delayedUntil, setDelayedUntil] = useState("")

  const handleStatus = async (status: "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "ARCHIVED") => {
    setLoading(true)
    const result = await updateChantierStatus(worksiteId, status)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Statut mis à jour.")
      router.refresh()
    }
  }

  const handleProlonger = async () => {
    if (!newEndDate) { toast.error("Veuillez saisir une nouvelle date."); return }
    setLoading(true)
    const formData = new FormData()
    formData.append("newEndDate", newEndDate)
    formData.append("reason", reason)
    const result = await prolongerChantier(worksiteId, formData)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Chantier prolongé.")
      setShowProlonger(false)
      setNewEndDate("")
      setReason("")
      router.refresh()
    }
  }

  const handleDecaler = async () => {
    if (!delayedUntil) { toast.error("Veuillez saisir une date de décalage."); return }
    setLoading(true)
    const formData = new FormData()
    formData.append("delayedUntil", delayedUntil)
    const result = await decalerChantier(worksiteId, formData)
    setLoading(false)
    if (result?.error) {
      toast.error(result.error)
    } else {
      toast.success("Chantier décalé.")
      setShowDecaler(false)
      setDelayedUntil("")
      router.refresh()
    }
  }

  const minDate = new Date(endDate)
  minDate.setDate(minDate.getDate() + 1)
  const minDateStr = minDate.toISOString().split("T")[0]

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-700">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {currentStatus === "PLANNED" && (
          <Button
            className="w-full bg-blue-600 hover:bg-blue-700"
            onClick={() => handleStatus("IN_PROGRESS")}
            disabled={loading}
          >
            Démarrer le chantier
          </Button>
        )}

        {["IN_PROGRESS", "EXTENDED"].includes(currentStatus) && (
          <>
            <Button
              className="w-full bg-green-600 hover:bg-green-700"
              onClick={() => handleStatus("COMPLETED")}
              disabled={loading}
            >
              Marquer comme terminé
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => { setShowProlonger(!showProlonger); setShowDecaler(false) }}
              disabled={loading}
            >
              Prolonger le chantier
            </Button>
            <Button
              variant="outline"
              className="w-full border-orange-300 text-orange-600 hover:bg-orange-50"
              onClick={() => { setShowDecaler(!showDecaler); setShowProlonger(false) }}
              disabled={loading}
            >
              Chantier Décalé
            </Button>
          </>
        )}

        {currentStatus === "DELAYED" && (
          <>
            <Button
              className="w-full bg-blue-600 hover:bg-blue-700"
              onClick={() => handleStatus("IN_PROGRESS")}
              disabled={loading}
            >
              Reprendre le chantier
            </Button>
            <Button
              variant="outline"
              className="w-full border-orange-300 text-orange-600 hover:bg-orange-50"
              onClick={() => { setShowDecaler(!showDecaler); setShowProlonger(false) }}
              disabled={loading}
            >
              Modifier le décalage
            </Button>
          </>
        )}

        {currentStatus === "COMPLETED" && (
          <Button
            variant="outline"
            className="w-full text-slate-500"
            onClick={() => handleStatus("ARCHIVED")}
            disabled={loading}
          >
            Archiver
          </Button>
        )}

        {showProlonger && (
          <div className="border rounded-lg p-3 space-y-3 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Nouvelle date de fin *</Label>
              <Input
                type="date"
                min={minDateStr}
                value={newEndDate}
                onChange={(e) => setNewEndDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Raison (optionnel)</Label>
              <Input
                placeholder="Raison de la prolongation..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <Button
              className="w-full bg-[#0f3460] hover:bg-[#0a2540]"
              onClick={handleProlonger}
              disabled={loading}
            >
              Confirmer la prolongation
            </Button>
          </div>
        )}

        {showDecaler && (
          <div className="border border-orange-200 rounded-lg p-3 space-y-3 mt-2 bg-orange-50/50">
            <div className="space-y-1.5">
              <Label className="text-xs text-orange-700">Date de reprise prévue *</Label>
              <Input
                type="date"
                min={new Date().toISOString().split("T")[0]}
                value={delayedUntil}
                onChange={(e) => setDelayedUntil(e.target.value)}
                className="border-orange-200 focus-visible:ring-orange-400"
              />
            </div>
            <Button
              className="w-full bg-orange-500 hover:bg-orange-600"
              onClick={handleDecaler}
              disabled={loading}
            >
              Confirmer le décalage
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
