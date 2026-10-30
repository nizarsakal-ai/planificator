"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { HardDrive, Wifi, WifiOff, CheckCircle, Loader2, AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

/**
 * Paramètres — connexion Google Drive des photos d'engins (SPEC-WORKSITE-PHOTOS-001 §7.5, D16).
 * UI sans logique métier : affiche l'état renvoyé par le serveur, lance le flux OAuth, demande la déconnexion locale.
 */
export interface WorksitePhotosDriveCardConnection {
  accountEmail: string
  status: "ACTIVE" | "ERROR" | "DISCONNECTED"
  connectedAt: Date
  lastErrorCode: string | null
}

interface Props {
  connection: WorksitePhotosDriveCardConnection | null
  driveParam?: string | null
  reasonParam?: string | null
}

const REASONS: Record<string, string> = {
  denied: "Vous avez refusé l'accès.",
  access_denied: "Vous avez refusé l'accès.",
  missing_params: "Réponse Google incomplète.",
  invalid_state: "Lien expiré ou invalide. Relancez la connexion.",
  not_configured: "OAuth Google non configuré côté serveur.",
  token_exchange_failed: "Google n'a pas répondu. Réessayez.",
  no_tokens: "Google n'a pas fourni de jeton de longue durée. Réessayez en acceptant l'accès hors ligne.",
  scope_missing: "L'accès aux fichiers Drive n'a pas été accordé.",
}

export function WorksitePhotosDriveCard({ connection, driveParam, reasonParam }: Props) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const active = connection?.status === "ACTIVE"

  async function handleDisconnect() {
    if (!confirm("Déconnecter Drive pour les photos d'engins ? Les jetons sont effacés localement ; l'accès Google reste à révoquer dans votre compte Google (cela couperait aussi Gmail).")) return
    setLoading(true)
    try {
      const res = await fetch("/api/worksite-photos/drive/disconnect", { method: "POST" })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(body.error ?? "Déconnexion impossible")
        return
      }
      toast.success("Drive déconnecté (localement)")
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  const fmtDate = (d: Date) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(d))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <HardDrive className="h-4 w-4" /> Google Drive — Photos d&apos;engins
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {driveParam === "connected" && (
          <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg border border-green-100">
            <CheckCircle className="h-4 w-4 shrink-0" /> Drive connecté avec succès.
          </div>
        )}
        {driveParam === "error" && (
          <div className="text-sm text-red-700 bg-red-50 px-3 py-2 rounded-lg border border-red-100">
            Erreur lors de la connexion. {REASONS[reasonParam ?? ""] ?? "Réessayez."}
          </div>
        )}
        {connection?.status === "ERROR" && (
          <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>Google refuse le renouvellement du jeton. Les envois de photos sont suspendus : reconnectez le compte.</span>
          </div>
        )}

        <div className="flex items-center gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100">
          <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${active ? "bg-green-100" : "bg-slate-200"}`}>
            {active ? <Wifi className="h-4 w-4 text-green-600" /> : <WifiOff className="h-4 w-4 text-slate-400" />}
          </div>
          <div className="flex-1 min-w-0">
            {connection && connection.status !== "DISCONNECTED" ? (
              <>
                <p className="text-sm font-medium text-slate-800 truncate">{connection.accountEmail || "Compte Google"}</p>
                <p className="text-xs text-slate-500">Connecté le {fmtDate(connection.connectedAt)}{connection.status === "ERROR" ? " · renouvellement refusé" : ""}</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-600">Non connecté</p>
                <p className="text-xs text-slate-400">Stockage des photos Avant / Après dans le dossier « Chantiers » du Drive de l&apos;entreprise</p>
              </>
            )}
          </div>
        </div>

        {active ? (
          <Button variant="outline" size="sm" className="w-full text-red-600 border-red-200 hover:bg-red-50" onClick={handleDisconnect} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Déconnecter (local)
          </Button>
        ) : (
          <Button size="sm" className="w-full bg-[#0f3460] hover:bg-[#0a2540]" asChild>
            <a href="/api/auth/drive">{connection?.status === "ERROR" ? "Reconnecter Google Drive" : "Connecter Google Drive"}</a>
          </Button>
        )}
        <p className="text-[11px] text-slate-400">
          Accès limité aux fichiers créés par Planificator (scope <code>drive.file</code>). Jetons chiffrés côté serveur ; aucun ouvrier n&apos;accède à Drive.
        </p>
      </CardContent>
    </Card>
  )
}
