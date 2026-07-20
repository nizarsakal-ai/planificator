"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { convertImportDraftAction } from "@/lib/actions/acquisition-conversion.actions"

export type ConversionClientOption = {
  id: string
  name: string
}

export function ConsultationConversionPanel({
  draftId,
  version,
  proposedClientName,
  conversionEnabled,
  clients,
  convertedWorksiteId,
}: {
  draftId: string
  version: number
  proposedClientName: string | null
  conversionEnabled: boolean
  clients: ConversionClientOption[]
  convertedWorksiteId?: string | null
}) {
  const router = useRouter()
  const [mode, setMode] = useState<"EXISTING" | "NEW">(
    clients.length > 0 ? "EXISTING" : "NEW"
  )
  const [existingClientId, setExistingClientId] = useState(clients[0]?.id ?? "")
  const [newName, setNewName] = useState(proposedClientName ?? "")
  const [newEmail, setNewEmail] = useState("")
  const [newPhone, setNewPhone] = useState("")
  const [newAddress, setNewAddress] = useState("")
  const [pending, startTransition] = useTransition()

  if (convertedWorksiteId) {
    return (
      <div className="rounded-md border bg-violet-50 p-4 text-sm space-y-2">
        <p className="font-medium text-violet-900">Consultation convertie en chantier</p>
        <Link
          href={`/chantiers/${convertedWorksiteId}`}
          className="text-[#0f3460] underline underline-offset-2"
        >
          Ouvrir le chantier
        </Link>
      </div>
    )
  }

  if (!conversionEnabled) {
    return (
      <p className="text-sm text-muted-foreground">
        Conversion désactivée (flag ACQUISITION_CONVERSION_ENABLED).
      </p>
    )
  }

  function convert() {
    startTransition(async () => {
      const payload =
        mode === "EXISTING"
          ? {
              draftId,
              expectedVersion: version,
              clientMode: "EXISTING" as const,
              existingClientId,
            }
          : {
              draftId,
              expectedVersion: version,
              clientMode: "NEW" as const,
              newClient: {
                name: newName,
                email: newEmail || null,
                phone: newPhone || null,
                address: newAddress || null,
              },
            }

      const result = await convertImportDraftAction(payload)
      if (!result.ok) {
        toast.error(result.message)
        if (result.outcome === "STATE_CHANGED") router.refresh()
        return
      }
      toast.success(
        result.outcome === "ALREADY_CONVERTED"
          ? "Chantier déjà créé"
          : "Chantier créé avec succès"
      )
      router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="clientMode"
            checked={mode === "EXISTING"}
            onChange={() => setMode("EXISTING")}
            disabled={pending || clients.length === 0}
          />
          Client existant
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="clientMode"
            checked={mode === "NEW"}
            onChange={() => setMode("NEW")}
            disabled={pending}
          />
          Nouveau client
        </label>
      </div>

      {mode === "EXISTING" ? (
        <div className="space-y-1.5">
          <Label htmlFor="existingClient">Client</Label>
          <select
            id="existingClient"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={existingClientId}
            onChange={(e) => setExistingClientId(e.target.value)}
            disabled={pending || clients.length === 0}
          >
            {clients.length === 0 ? (
              <option value="">Aucun client</option>
            ) : (
              clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))
            )}
          </select>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="newClientName">Nom du client</Label>
            <Input
              id="newClientName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="newClientEmail">Email (optionnel)</Label>
            <Input
              id="newClientEmail"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="newClientPhone">Téléphone (optionnel)</Label>
            <Input
              id="newClientPhone"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="newClientAddress">Adresse (optionnel)</Label>
            <Input
              id="newClientAddress"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              disabled={pending}
            />
          </div>
        </div>
      )}

      <Button
        type="button"
        onClick={convert}
        disabled={
          pending ||
          (mode === "EXISTING" && !existingClientId) ||
          (mode === "NEW" && newName.trim().length === 0)
        }
      >
        {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Créer le chantier
      </Button>
    </div>
  )
}
