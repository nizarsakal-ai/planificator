"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Mail, Plus, CheckCircle } from "lucide-react"

type Connection = {
  id: string
  gmailAddress: string
  tokenExpiry: Date | string
  active: boolean
}

type Props = {
  connections: Connection[]
  acquisitionGmailParam?: string | null
}

/**
 * Connexions Gmail multi-compte Acquisition — distinct du card Booking.
 * OAuth : /api/acquisition/gmail/connect (jamais /api/auth/gmail).
 */
export function AcquisitionGmailConnectionsCard({
  connections,
  acquisitionGmailParam,
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
        <p className="text-sm text-red-600">Échec de la connexion Gmail Acquisition.</p>
      )}

      <ul className="space-y-2">
        {connections.length === 0 && (
          <li className="text-sm text-slate-500">Aucune boîte Acquisition connectée.</li>
        )}
        {connections.map((c) => {
          const expired = new Date(c.tokenExpiry).getTime() < Date.now()
          return (
            <li
              key={c.id}
              className="flex items-center justify-between text-sm border border-slate-100 rounded px-3 py-2"
            >
              <span className="font-mono text-slate-800">{c.gmailAddress}</span>
              <span className={expired ? "text-amber-600" : "text-emerald-700"}>
                {!c.active ? "inactive" : expired ? "token expiré" : "active"}
              </span>
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
