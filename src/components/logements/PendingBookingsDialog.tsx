"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  CalendarDays,
  MapPin,
  CheckCircle,
  X,
  Loader2,
  BedDouble,
  AlertTriangle,
  Save,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  confirmPendingAccommodation,
  dismissPendingAccommodation,
  updatePendingAccommodation,
} from "@/lib/actions/gmail.actions"
import { toast } from "sonner"
import {
  isPendingReady,
} from "@/lib/booking/booking-pending-ready"
import { formatDateOnlyForInput } from "@/lib/booking/booking-date-only"
import type { PendingAccommodationListItem } from "./pending-accommodation-list.types"

interface Team {
  id: string
  name: string
}

interface Props {
  open: boolean
  onClose: () => void
  pendings: PendingAccommodationListItem[]
  teams: Team[]
  filterLabel?: string
}

type Draft = {
  propertyName: string
  address: string
  city: string
  zipCode: string
  startDate: string
  endDate: string
  doorCode: string
  contactName: string
  contactPhone: string
  notes: string
  teamId: string
}

function draftFromPending(p: PendingAccommodationListItem): Draft {
  return {
    propertyName: p.propertyName ?? "",
    address: p.address ?? "",
    city: p.city ?? "",
    zipCode: p.zipCode ?? "",
    startDate: formatDateOnlyForInput(p.startDate),
    endDate: formatDateOnlyForInput(p.endDate),
    doorCode: p.doorCode ?? "",
    contactName: p.contactName ?? "",
    contactPhone: p.contactPhone ?? "",
    notes: p.notes ?? "",
    teamId: "",
  }
}

function fmtCreated(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d))
}

export function PendingBookingsDialog({
  open,
  onClose,
  pendings,
  teams,
  filterLabel = "Tous",
}: Props) {
  const router = useRouter()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setDrafts((prev) => {
      const next = { ...prev }
      for (const p of pendings) {
        if (!next[p.id]) next[p.id] = draftFromPending(p)
      }
      return next
    })
  }, [open, pendings])

  const visible = pendings.filter((p) => !dismissed.has(p.id) && !confirmed.has(p.id))

  function setField(id: string, key: keyof Draft, value: string) {
    setDrafts((prev) => {
      const existing = prev[id] ?? (() => {
        const row = pendings.find((x) => x.id === id)
        return row ? draftFromPending(row) : null
      })()
      if (!existing) return prev
      return { ...prev, [id]: { ...existing, [key]: value } }
    })
  }

  function handleSave(id: string) {
    const d = drafts[id]
    if (!d) return
    startTransition(async () => {
      const res = await updatePendingAccommodation(id, {
        propertyName: d.propertyName,
        address: d.address,
        city: d.city,
        zipCode: d.zipCode,
        startDate: d.startDate || null,
        endDate: d.endDate || null,
        doorCode: d.doorCode,
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        notes: d.notes,
      })
      if ("error" in res && res.error) {
        toast.error(res.error)
        return
      }
      toast.success("Modifications enregistrées.")
      router.refresh()
    })
  }

  function handleConfirm(id: string) {
    const d = drafts[id]
    if (!d?.teamId) {
      toast.error("Sélectionnez une équipe d'abord.")
      return
    }
    if (!d.address.trim()) {
      toast.error("Adresse manquante — saisissez l'adresse du logement.")
      return
    }
    if (!d.startDate || !d.endDate) {
      toast.error("Dates d'arrivée et de départ requises.")
      return
    }
    startTransition(async () => {
      const saveRes = await updatePendingAccommodation(id, {
        propertyName: d.propertyName,
        address: d.address,
        city: d.city,
        zipCode: d.zipCode,
        startDate: d.startDate || null,
        endDate: d.endDate || null,
        doorCode: d.doorCode,
        contactName: d.contactName,
        contactPhone: d.contactPhone,
        notes: d.notes,
      })
      if ("error" in saveRes && saveRes.error) {
        toast.error(saveRes.error)
        return
      }

      const res = await confirmPendingAccommodation(id, d.teamId)
      if ("error" in res) {
        toast.error(res.error)
        return
      }
      toast.success(
        res.idempotent ? "Logement déjà confirmé." : "Logement créé et équipe notifiée."
      )
      setConfirmed((prev) => new Set([...prev, id]))
      router.refresh()
    })
  }

  function handleDismiss(id: string) {
    startTransition(async () => {
      const res = await dismissPendingAccommodation(id)
      if (res.error) {
        toast.error(res.error)
        return
      }
      toast.success("Réservation rejetée.")
      setDismissed((prev) => new Set([...prev, id]))
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BedDouble className="h-4 w-4 text-amber-500" />
            Logements Booking à valider ({visible.length})
            <Badge variant="secondary" className="text-xs font-normal">
              {filterLabel}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {visible.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            Aucune réservation dans ce filtre.
          </div>
        ) : (
          <div className="space-y-5">
            {visible.map((p) => {
              const d = drafts[p.id] ?? draftFromPending(p)
              const ready = isPendingReady({
                address: d.address,
                startDate: d.startDate || null,
                endDate: d.endDate || null,
              })
              const canValidate = Boolean(d.teamId && ready)

              return (
                <div
                  key={p.id}
                  className="space-y-3 rounded-xl border border-slate-100 bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {d.propertyName.trim() || "Logement Booking.com"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        Reçu le {fmtCreated(p.createdAt)}
                        {p.gmailMessageId ? ` · Gmail ${p.gmailMessageId.slice(0, 12)}…` : ""}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={`shrink-0 text-xs ${
                        ready
                          ? "border-green-200 bg-green-50 text-green-700"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                      }`}
                    >
                      {ready ? "Prêt" : "Incomplet"}
                    </Badge>
                  </div>

                  {!ready && (
                    <div className="flex items-start gap-1.5 rounded-md border border-amber-100 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      Adresse et dates obligatoires avant validation.
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block text-xs text-slate-600 sm:col-span-2">
                      Propriété
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.propertyName}
                        onChange={(e) => setField(p.id, "propertyName", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600 sm:col-span-2">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> Adresse
                      </span>
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.address}
                        onChange={(e) => setField(p.id, "address", e.target.value)}
                        placeholder="12 rue de la Paix"
                        autoComplete="street-address"
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      Ville
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.city}
                        onChange={(e) => setField(p.id, "city", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      Code postal
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.zipCode}
                        onChange={(e) => setField(p.id, "zipCode", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="h-3 w-3" /> Arrivée
                      </span>
                      <Input
                        type="date"
                        className="mt-1 h-8 text-xs"
                        value={d.startDate}
                        onChange={(e) => setField(p.id, "startDate", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      Départ
                      <Input
                        type="date"
                        className="mt-1 h-8 text-xs"
                        value={d.endDate}
                        min={d.startDate || undefined}
                        onChange={(e) => setField(p.id, "endDate", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      Digicode
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.doorCode}
                        onChange={(e) => setField(p.id, "doorCode", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600">
                      Contact
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.contactName}
                        onChange={(e) => setField(p.id, "contactName", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600 sm:col-span-2">
                      Téléphone
                      <Input
                        className="mt-1 h-8 text-xs"
                        value={d.contactPhone}
                        onChange={(e) => setField(p.id, "contactPhone", e.target.value)}
                      />
                    </label>
                    <label className="block text-xs text-slate-600 sm:col-span-2">
                      Notes
                      <textarea
                        className="mt-1 min-h-[56px] w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#0f3460]"
                        value={d.notes}
                        onChange={(e) => setField(p.id, "notes", e.target.value)}
                      />
                    </label>
                  </div>

                  {p.emailPreview && (
                    <p className="line-clamp-2 rounded border border-slate-100 bg-white px-2 py-1.5 text-xs italic text-slate-400">
                      {p.emailPreview}
                    </p>
                  )}

                  <select
                    value={d.teamId}
                    onChange={(e) => setField(p.id, "teamId", e.target.value)}
                    className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-[#0f3460]"
                  >
                    <option value="" disabled>
                      Choisir une équipe…
                    </option>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={() => handleSave(p.id)}
                      disabled={isPending}
                    >
                      {isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <Save className="mr-1 h-3 w-3" /> Enregistrer
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      className="h-8 flex-1 bg-[#0f3460] text-xs hover:bg-[#0f3460]/90"
                      onClick={() => handleConfirm(p.id)}
                      disabled={isPending || !canValidate}
                    >
                      {isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <CheckCircle className="mr-1 h-3 w-3" /> Valider et créer
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs text-slate-500"
                      onClick={() => handleDismiss(p.id)}
                      disabled={isPending}
                    >
                      <X className="mr-1 h-3 w-3" /> Rejeter
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
