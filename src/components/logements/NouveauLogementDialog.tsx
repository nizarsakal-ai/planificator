"use client"

import { useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { BedDouble, Loader2, Sparkles, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { createLogement, parseLogementText } from "@/lib/actions/logement.actions"

interface Team {
  id: string
  name: string
}

interface ParsedData {
  teamName?: string | null
  startDate?: string | null
  endDate?: string | null
  address?: string | null
  city?: string | null
  zipCode?: string | null
  doorCode?: string | null
  contactName?: string | null
  contactPhone?: string | null
  notes?: string | null
}

export function NouveauLogementDialog({ teams }: { teams: Team[] }) {
  const router = useRouter()
  const [open, setOpen]       = useState(false)
  const [tab, setTab]         = useState<"form" | "ai">("form")
  const [loading, setLoading] = useState(false)
  const [aiText, setAiText]   = useState("")
  const [aiLoading, setAiLoading] = useState(false)

  // Form fields
  const [teamId, setTeamId]         = useState("")
  const [startDate, setStartDate]   = useState("")
  const [endDate, setEndDate]       = useState("")
  const [address, setAddress]       = useState("")
  const [city, setCity]             = useState("")
  const [zipCode, setZipCode]       = useState("")
  const [doorCode, setDoorCode]     = useState("")
  const [contactName, setContactName]   = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [notes, setNotes]           = useState("")

  function resetForm() {
    setTeamId(""); setStartDate(""); setEndDate("")
    setAddress(""); setCity(""); setZipCode("")
    setDoorCode(""); setContactName(""); setContactPhone(""); setNotes("")
    setAiText("")
  }

  async function handleAiParse() {
    if (!aiText.trim()) { toast.error("Saisissez un texte à analyser."); return }
    setAiLoading(true)
    const result = await parseLogementText(aiText)
    setAiLoading(false)

    if (result.error) { toast.error(result.error); return }

    const d: ParsedData = result.data ?? {}

    // Pré-remplir les champs avec les données IA
    if (d.teamName) {
      const match = teams.find((t) =>
        t.name.toLowerCase().includes(d.teamName!.toLowerCase()) ||
        d.teamName!.toLowerCase().includes(t.name.toLowerCase())
      )
      if (match) setTeamId(match.id)
    }
    if (d.startDate)    setStartDate(d.startDate)
    if (d.endDate)      setEndDate(d.endDate)
    if (d.address)      setAddress(d.address)
    if (d.city)         setCity(d.city)
    if (d.zipCode)      setZipCode(d.zipCode)
    if (d.doorCode)     setDoorCode(d.doorCode)
    if (d.contactName)  setContactName(d.contactName)
    if (d.contactPhone) setContactPhone(d.contactPhone)
    if (d.notes)        setNotes(d.notes)

    setTab("form")
    toast.success("Formulaire pré-rempli — vérifiez et validez.")
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append("teamId",       teamId)
      formData.append("startDate",    startDate)
      formData.append("endDate",      endDate)
      formData.append("address",      address)
      formData.append("city",         city)
      formData.append("zipCode",      zipCode)
      formData.append("doorCode",     doorCode)
      formData.append("contactName",  contactName)
      formData.append("contactPhone", contactPhone)
      formData.append("notes",        notes)

      const result = await createLogement(formData)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success("Logement créé et équipe notifiée !")
        resetForm()
        setOpen(false)
        router.refresh()
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm() }}>
      <DialogTrigger asChild>
        <Button className="bg-[#0f3460] hover:bg-[#0a2540] gap-1.5">
          <BedDouble className="h-4 w-4" />
          Nouveau logement
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Créer un logement</DialogTitle>
        </DialogHeader>

        {/* Tab switcher */}
        <div className="flex gap-1 bg-slate-100 rounded-lg p-1 mb-4">
          <button
            type="button"
            onClick={() => setTab("form")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === "form" ? "bg-white text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Formulaire
          </button>
          <button
            type="button"
            onClick={() => setTab("ai")}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === "ai" ? "bg-white text-[#0f3460] shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Saisie libre IA
          </button>
        </div>

        {/* Tab IA */}
        {tab === "ai" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Décrivez la réservation en langage naturel. L'IA remplira le formulaire automatiquement.
            </p>
            <textarea
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              placeholder={`Ex: Réservation MAKRAM du 29 juin au 5 juillet, Résidence Les Pins 12 rue Voltaire Paris 11e, code porte 4521B, contact Martine au 06 12 34 56 78`}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
            />
            <Button
              type="button"
              onClick={handleAiParse}
              disabled={aiLoading}
              className="w-full bg-[#0f3460] hover:bg-[#0a2540]"
            >
              {aiLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Analyse en cours…</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-2" /> Analyser avec l'IA</>
              )}
            </Button>
          </div>
        )}

        {/* Formulaire */}
        {tab === "form" && (
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* Équipe */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Équipe *</Label>
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                required
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">-- Choisir une équipe --</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Date d'arrivée *</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Date de départ *</Label>
                <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} required />
              </div>
            </div>

            {/* Adresse */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Adresse *</Label>
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 rue Voltaire" required />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Ville</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Paris" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Code postal</Label>
                <Input value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="75011" />
              </div>
            </div>

            {/* Accès */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Code porte / accès</Label>
              <Input value={doorCode} onChange={(e) => setDoorCode(e.target.value)} placeholder="4521B" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Nom du contact</Label>
                <Input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Martine" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-slate-500">Téléphone contact</Label>
                <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="06 12 34 56 78" />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-1">
              <Label className="text-xs text-slate-500">Notes</Label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Informations supplémentaires…"
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-[#0f3460]/20"
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full bg-[#0f3460] hover:bg-[#0a2540]">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Créer le logement"}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
