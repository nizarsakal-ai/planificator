"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  approveImportDraftAction,
  rejectImportDraftAction,
  reExtractImportDraftAction,
  saveImportDraftCorrectionsAction,
} from "@/lib/actions/acquisition-review.actions"
import type { ConsultationProposedFormDto } from "@/lib/acquisition/review/import-draft-review.types"
import { getConsultationUiActions } from "@/lib/acquisition/review/consultation-ui"

type FormState = {
  proposedWorksiteName: string
  proposedClientName: string
  proposedAddress: string
  proposedPostalCode: string
  proposedCity: string
  proposedStartDate: string
  proposedEndDate: string
  proposedDescription: string
}

function dtoToForm(dto: ConsultationProposedFormDto): FormState {
  return {
    proposedWorksiteName: dto.proposedWorksiteName ?? "",
    proposedClientName: dto.proposedClientName ?? "",
    proposedAddress: dto.proposedAddress ?? "",
    proposedPostalCode: dto.proposedPostalCode ?? "",
    proposedCity: dto.proposedCity ?? "",
    proposedStartDate: dto.proposedStartDate ?? "",
    proposedEndDate: dto.proposedEndDate ?? "",
    proposedDescription: dto.proposedDescription ?? "",
  }
}

export function ConsultationProposedForm({ form: dto }: { form: ConsultationProposedFormDto }) {
  const router = useRouter()
  const actions = getConsultationUiActions(dto.status, {
    extractionEnabled: dto.extractionEnabled,
  })
  const [version, setVersion] = useState(dto.version)
  const [form, setForm] = useState<FormState>(() => dtoToForm(dto))
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectionReason, setRejectionReason] = useState("")

  const readOnly = !actions.canEdit

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function save() {
    setBusy("save")
    startTransition(async () => {
      const result = await saveImportDraftCorrectionsAction({
        draftId: dto.id,
        expectedVersion: version,
        ...form,
      })
      setBusy(null)
      if (!result.ok) {
        toast.error(result.message)
        if (result.outcome === "STATE_CHANGED") router.refresh()
        return
      }
      setVersion(result.version)
      toast.success("Corrections enregistrées")
      router.refresh()
    })
  }

  function approve() {
    setBusy("approve")
    startTransition(async () => {
      const result = await approveImportDraftAction({
        draftId: dto.id,
        expectedVersion: version,
      })
      setBusy(null)
      if (!result.ok) {
        toast.error(result.message)
        if (result.outcome === "STATE_CHANGED") router.refresh()
        return
      }
      toast.success("Consultation approuvée")
      router.refresh()
    })
  }

  function reject() {
    setBusy("reject")
    startTransition(async () => {
      const result = await rejectImportDraftAction({
        draftId: dto.id,
        expectedVersion: version,
        rejectionReason,
      })
      setBusy(null)
      if (!result.ok) {
        toast.error(result.message)
        if (result.outcome === "STATE_CHANGED") router.refresh()
        return
      }
      setRejectOpen(false)
      toast.success("Consultation rejetée")
      router.refresh()
    })
  }

  function reExtract() {
    setBusy("reextract")
    startTransition(async () => {
      const result = await reExtractImportDraftAction({ draftId: dto.id })
      setBusy(null)
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success("Extraction relancée")
      router.refresh()
    })
  }

  const loading = pending || busy !== null

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Nom du chantier"
          value={form.proposedWorksiteName}
          onChange={(v) => setField("proposedWorksiteName", v)}
          disabled={readOnly || loading}
        />
        <Field
          label="Client (texte)"
          value={form.proposedClientName}
          onChange={(v) => setField("proposedClientName", v)}
          disabled={readOnly || loading}
        />
        <Field
          label="Adresse"
          value={form.proposedAddress}
          onChange={(v) => setField("proposedAddress", v)}
          disabled={readOnly || loading}
          className="sm:col-span-2"
        />
        <Field
          label="Code postal"
          value={form.proposedPostalCode}
          onChange={(v) => setField("proposedPostalCode", v)}
          disabled={readOnly || loading}
        />
        <Field
          label="Ville"
          value={form.proposedCity}
          onChange={(v) => setField("proposedCity", v)}
          disabled={readOnly || loading}
        />
        <Field
          label="Date de début"
          type="date"
          value={form.proposedStartDate}
          onChange={(v) => setField("proposedStartDate", v)}
          disabled={readOnly || loading}
        />
        <Field
          label="Date de fin"
          type="date"
          value={form.proposedEndDate}
          onChange={(v) => setField("proposedEndDate", v)}
          disabled={readOnly || loading}
        />
        <div className="sm:col-span-2 space-y-1.5">
          <Label htmlFor="proposedDescription">Description</Label>
          <Textarea
            id="proposedDescription"
            value={form.proposedDescription}
            onChange={(e) => setField("proposedDescription", e.target.value)}
            disabled={readOnly || loading}
            rows={4}
          />
        </div>
      </div>

      {(dto.proposedContactName || dto.proposedContactEmail || dto.proposedContactPhone) && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">Contact (lecture seule)</div>
          <div>{dto.proposedContactName ?? "—"}</div>
          <div>{dto.proposedContactEmail ?? "—"}</div>
          <div>{dto.proposedContactPhone ?? "—"}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {actions.canSave ? (
          <Button type="button" onClick={save} disabled={loading}>
            {busy === "save" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Enregistrer
          </Button>
        ) : null}
        {actions.canApprove ? (
          <Button type="button" variant="default" onClick={approve} disabled={loading}>
            {busy === "approve" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approuver
          </Button>
        ) : null}
        {actions.canReject ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => setRejectOpen(true)}
            disabled={loading}
          >
            Rejeter
          </Button>
        ) : null}
        {actions.canReExtract ? (
          <Button type="button" variant="outline" onClick={reExtract} disabled={loading}>
            {busy === "reextract" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Relancer l’extraction
          </Button>
        ) : null}
        {!dto.extractionEnabled && dto.status !== "APPROVED" && dto.status !== "REJECTED" ? (
          <span className="self-center text-xs text-muted-foreground">
            Extraction désactivée (flag)
          </span>
        ) : null}
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rejeter la consultation</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rejectionReason">Motif (5 à 500 caractères)</Label>
            <Textarea
              id="rejectionReason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={4}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectOpen(false)}>
              Annuler
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={reject}
              disabled={loading || rejectionReason.trim().length < 5}
            >
              {busy === "reject" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirmer le rejet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  disabled,
  type = "text",
  className,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  type?: string
  className?: string
}) {
  const id = label.replace(/\s+/g, "-").toLowerCase()
  return (
    <div className={className ? `${className} space-y-1.5` : "space-y-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  )
}
