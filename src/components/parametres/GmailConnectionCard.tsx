"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Mail, Wifi, WifiOff, CheckCircle, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { disconnectGmail } from "@/lib/actions/gmail.actions"

interface Props {
  connection: { gmailAddress: string; connectedAt: Date } | null
  gmailParam?: string | null
}

export function GmailConnectionCard({ connection, gmailParam }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleDisconnect() {
    setLoading(true)
    try {
      await disconnectGmail()
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(d))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Mail className="h-4 w-4" /> Connexion Gmail — Booking.com
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {gmailParam === "connected" && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg border border-green-100">
            <CheckCircle className="h-4 w-4 shrink-0" />
            Gmail connecté avec succès !
          </div>
        )}
        {gmailParam === "error" && (
          <div className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg border border-red-100">
            Erreur lors de la connexion. Réessayez.
          </div>
        )}

        <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${connection ? "bg-green-100" : "bg-slate-200"}`}>
            {connection
              ? <Wifi className="h-4 w-4 text-green-600" />
              : <WifiOff className="h-4 w-4 text-slate-400" />}
          </div>
          <div className="flex-1 min-w-0">
            {connection ? (
              <>
                <p className="text-sm font-medium text-slate-800 truncate">{connection.gmailAddress}</p>
                <p className="text-xs text-slate-500">Connecté le {fmtDate(connection.connectedAt)}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-600">Non connecté</p>
                <p className="text-xs text-slate-400">
                  Détection automatique des réservations Booking.com
                </p>
              </>
            )}
          </div>
        </div>

        {connection ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full text-red-600 border-red-200 hover:bg-red-50"
            onClick={handleDisconnect}
            disabled={loading}
          >
            {loading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : "Déconnecter Gmail"}
          </Button>
        ) : (
          <Button
            size="sm"
            className="w-full bg-[#0f3460] hover:bg-[#0f3460]/90"
            onClick={() => { window.location.href = "/api/auth/gmail" }}
          >
            <Mail className="h-4 w-4 mr-2" />
            Connecter Gmail
          </Button>
        )}

        <p className="text-xs text-slate-400 leading-relaxed">
          Planificator scannera votre boîte Gmail (lecture seule) chaque heure pour détecter les confirmations Booking.com et vous notifier afin d&apos;affecter une équipe en un clic.
        </p>
      </CardContent>
    </Card>
  )
}
