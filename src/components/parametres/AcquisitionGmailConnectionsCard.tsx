"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Mail, Plus, CheckCircle } from "lucide-react"
import {
  acquisitionGmailOAuthErrorMessage,
  type MailboxHealth,
  type MailboxHealthLevel,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"

type Connection = {
  id: string
  gmailAddress: string
  /** Santé calculée côté serveur (évite un écart d'hydratation sur « il y a X min »). */
  health: MailboxHealth
}

type Props = {
  connections: Connection[]
  acquisitionGmailParam?: string | null
  reasonParam?: string | null
}

const LEVEL_CLASS: Record<MailboxHealthLevel, string> = {
  ok: "text-emerald-700",
  pending: "text-slate-500",
  warning: "text-amber-600",
  error: "text-red-600",
  inactive: "text-slate-400",
}

/**
 * Connexions Gmail multi-compte Acquisition — distinct du card Booking.
 * OAuth : /api/acquisition/gmail/connect (jamais /api/auth/gmail).
 */
export function AcquisitionGmailConnectionsCard({
  connections,
  acquisitionGmailParam,
  reasonParam,
}: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  function connect() {
    setLoading(true)
    window.location.href = "/api/acquisition/gmail/connect"
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Mail className="h-4 w-4 text-slate-600" />
        <h3 className="font-medium text-slate-900">Gmail Consultations</h3>
      </div>
      <p className="text-sm text-slate-600">
        Boîtes scannées pour les consultations (multi-compte). Indépendant de Booking.
      </p>

      {acquisitionGmailParam === "connected" && (
        <div className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle className="h-4 w-4" />
          Connexion Gmail Acquisition enregistrée
        </div>
      )}
      {acquisitionGmailParam === "error" && (
        <p className="text-sm text-red-600">{acquisitionGmailOAuthErrorMessage(reasonParam)}</p>
      )}

      <ul className="space-y-2">
        {connections.length === 0 && (
          <li className="text-sm text-slate-500">Aucune boîte Acquisition connectée.</li>
        )}
        {connections.map((c) => {
          const { health } = c
          return (
            <li
              key={c.id}
              className="text-sm border border-slate-100 rounded px-3 py-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800 truncate">{c.gmailAddress}</span>
                <span className={`shrink-0 ${LEVEL_CLASS[health.level]}`}>{health.label}</span>
              </div>
              {health.hint && <p className="text-xs text-slate-500">{health.hint}</p>}
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={connect}
        disabled={loading}
        className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-60"
      >
        <Plus className="h-4 w-4" />
        {loading ? "Redirection…" : "Connecter une boîte Gmail"}
      </button>
      <button
        type="button"
        className="ml-2 text-xs text-slate-500 underline"
        onClick={() => router.refresh()}
      >
        Actualiser
      </button>
    </div>
  )
}
