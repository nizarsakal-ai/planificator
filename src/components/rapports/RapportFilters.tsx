"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Download, Filter } from "lucide-react"

interface Team     { id: string; name: string }
interface Chantier { id: string; name: string }

interface Props {
  teams:     Team[]
  chantiers: Chantier[]
}

export function RapportFilters({ teams, chantiers }: Props) {
  const [from,       setFrom]       = useState("")
  const [to,         setTo]         = useState("")
  const [teamId,     setTeamId]     = useState("all")
  const [chantierId, setChantierId] = useState("all")
  const [loading,    setLoading]    = useState(false)

  function handleExport() {
    const params = new URLSearchParams()
    if (from)                    params.set("from",       from)
    if (to)                      params.set("to",         to)
    if (teamId     !== "all")    params.set("teamId",     teamId)
    if (chantierId !== "all")    params.set("chantierId", chantierId)

    setLoading(true)
    const url = `/api/export/affectations?${params.toString()}`

    // Déclenche le téléchargement
    const a = document.createElement("a")
    a.href = url
    a.download = ""
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)

    setTimeout(() => setLoading(false), 2000)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Filter className="h-4 w-4" /> Export Excel
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Du</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Au</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Équipe</Label>
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">Toutes les équipes</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Chantier</Label>
            <select
              value={chantierId}
              onChange={(e) => setChantierId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="all">Tous les chantiers</option>
              {chantiers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        </div>

        <Button
          onClick={handleExport}
          disabled={loading}
          className="bg-[#0f3460] hover:bg-[#0f3460]/90 text-white"
        >
          <Download className="h-4 w-4 mr-2" />
          {loading ? "Génération…" : "Exporter Excel"}
        </Button>
        <p className="text-xs text-slate-400 mt-2">
          Sans filtre de date, toutes les affectations sont exportées.
        </p>
      </CardContent>
    </Card>
  )
}
