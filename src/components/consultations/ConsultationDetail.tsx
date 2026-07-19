import Link from "next/link"
import type { ImportDraftReviewBundle } from "@/lib/acquisition/review/import-draft-review.types"
import {
  CONSULTATION_STATUS_BADGE_CLASS,
  CONSULTATION_STATUS_LABELS,
  formatConfidencePercent,
  mapWarningDataToPublicView,
} from "@/lib/acquisition/review/consultation-ui"
import { ConsultationProposedForm } from "@/components/consultations/ConsultationProposedForm"
import { toConsultationProposedFormDto } from "@/lib/acquisition/review/consultation-proposed-form.dto"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

function fmt(d: Date | string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d))
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

export function ConsultationDetail({
  bundle,
  extractionEnabled,
}: {
  bundle: ImportDraftReviewBundle
  extractionEnabled: boolean
}) {
  const { draft, message, content, attachments } = bundle
  const warnings = mapWarningDataToPublicView(draft.warningData)
  const confidence =
    draft.confidenceData && typeof draft.confidenceData === "object"
      ? (draft.confidenceData as Record<string, unknown>)
      : {}

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/consultations" className="text-sm text-muted-foreground hover:underline">
            ← Consultations
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{message.subject}</h1>
          <p className="text-sm text-muted-foreground">
            {message.senderEmail} · reçu le {fmt(message.receivedAt)}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex rounded-full px-3 py-1 text-xs font-medium",
            CONSULTATION_STATUS_BADGE_CLASS[draft.status]
          )}
        >
          {CONSULTATION_STATUS_LABELS[draft.status]}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Message reçu</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Expéditeur :</span> {message.senderEmail}
          </div>
          <div>
            <span className="text-muted-foreground">Sujet :</span> {message.subject}
          </div>
          <div>
            <span className="text-muted-foreground">Date :</span> {fmt(message.receivedAt)}
          </div>
          <div className="pt-2">
            <div className="mb-1 text-muted-foreground">Contenu normalisé</div>
            {content.normalizedText ? (
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3 text-xs leading-relaxed">
                {content.normalizedText}
              </pre>
            ) : (
              <p className="rounded-md border border-dashed p-3 text-muted-foreground">
                Contenu non disponible
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pièces jointes</CardTitle>
        </CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune pièce jointe</p>
          ) : (
            <ul className="space-y-2">
              {attachments.map((a) => {
                const stored = a.status === "STORED"
                return (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                  >
                    <div>
                      <div className="font-medium">{a.filename}</div>
                      <div className="text-xs text-muted-foreground">
                        {a.mimeType} · {a.category} · {formatBytes(a.sizeBytes)} · {a.status}
                      </div>
                    </div>
                    {stored ? (
                      <div className="flex gap-2">
                        <Button asChild size="sm" variant="outline">
                          <a href={`/api/acquisition/attachments/${a.id}`} target="_blank" rel="noreferrer">
                            Ouvrir
                          </a>
                        </Button>
                        <Button asChild size="sm" variant="secondary">
                          <a href={`/api/acquisition/attachments/${a.id}?dl=1`}>Télécharger</a>
                        </Button>
                      </div>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        Indisponible
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Données proposées</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsultationProposedForm
            form={toConsultationProposedFormDto(draft, extractionEnabled)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Confiance et avertissements</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <div className="mb-2 font-medium">Confiance</div>
            {Object.keys(confidence).length === 0 ? (
              <p className="text-muted-foreground">Aucune donnée de confiance</p>
            ) : (
              <ul className="grid gap-1 sm:grid-cols-2">
                {Object.entries(confidence).map(([field, value]) => {
                  const pct = formatConfidencePercent(value)
                  if (!pct) return null
                  return (
                    <li key={field} className="flex justify-between rounded border px-2 py-1">
                      <span>{field}</span>
                      <span className="tabular-nums text-muted-foreground">{pct}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-2 font-medium">Avertissements</div>
            {warnings.length === 0 ? (
              <p className="text-muted-foreground">Aucun avertissement</p>
            ) : (
              <ul className="space-y-2">
                {warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} className="rounded border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{w.code}</span>
                      <span className="text-xs uppercase text-muted-foreground">{w.severity}</span>
                      {w.blocking ? (
                        <span className="rounded bg-red-100 px-1.5 text-xs text-red-800">
                          bloquant
                        </span>
                      ) : null}
                      {w.field ? (
                        <span className="text-xs text-muted-foreground">champ : {w.field}</span>
                      ) : null}
                    </div>
                    <p className="mt-1">{w.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {(draft.extractionProvider || draft.lastExtractionErrorCode || draft.rejectionReason) && (
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              {draft.extractionProvider ? (
                <div>
                  Provider : {draft.extractionProvider}
                  {draft.extractionModel ? ` · ${draft.extractionModel}` : ""}
                </div>
              ) : null}
              {draft.lastExtractionErrorCode ? (
                <div>Dernier code erreur : {draft.lastExtractionErrorCode}</div>
              ) : null}
              {draft.rejectionReason ? <div>Motif rejet : {draft.rejectionReason}</div> : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
