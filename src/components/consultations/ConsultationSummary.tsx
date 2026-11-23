"use client"

import { useActionState } from "react"
import { summarizeConsultationAction } from "@/lib/acquisition/assistant/consultation-summary.action"
import { Button } from "@/components/ui/button"

export function ConsultationSummary({ draftId }: { draftId: string }) {
  const [state, action, pending] = useActionState(summarizeConsultationAction.bind(null, draftId), { status: "idle" })
  return (
    <section aria-label="Assistant IA" className="space-y-2 border-t pt-3">
      <form action={action}>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Résumé en cours…" : "Résumer avec l’IA"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Le texte du message est transmis à Claude pour produire un résumé à relire.
      </p>
      <div aria-live="polite">
        {state.status === "ok" && <p className="whitespace-pre-wrap">{state.text}</p>}
        {state.status === "error" && <p className="text-destructive">{state.text}</p>}
      </div>
    </section>
  )
}
