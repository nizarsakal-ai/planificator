import Link from "next/link"
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react"
import type { IssuerIdentityAssessment } from "@/lib/billing/company-identity"

/** Liste de contrôle de l'identité juridique de l'émetteur (devis / factures). Composant serveur, sans état. */
export function CompanyIdentityCard({ assessment, legalFooter, billingLink = true }: { assessment: IssuerIdentityAssessment; legalFooter: string | null; billingLink?: boolean }) {
  const icon = (status: string) =>
    status === "ok" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="ok" />
    : status === "warning" ? <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-label="à vérifier" />
    : <XCircle className="h-4 w-4 shrink-0 text-red-500" aria-label="manquant" />
  return (
    <div className="space-y-3 text-sm">
      {assessment.blocking.length > 0 ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">
          Identité juridique incomplète pour émettre des devis et factures : {assessment.blocking.join(", ")}.
        </p>
      ) : (
        <p className="rounded-md border border-green-200 bg-green-50 p-2 text-green-700">Identité juridique complète pour l&apos;émission.</p>
      )}
      <ul className="space-y-1">
        {assessment.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            {icon(c.status)}
            <span><span className="font-medium">{c.label}</span>{c.status !== "ok" && c.hint ? <span className="text-slate-500"> — {c.hint}</span> : null}</span>
          </li>
        ))}
      </ul>
      <div className="text-xs text-slate-500">
        <p>Pied de page des documents : {legalFooter ? <span className="text-slate-700">{legalFooter}</span> : <span className="text-red-600">aucune donnée d&apos;identité disponible (le pied de page restera vide, jamais générique)</span>}</p>
        {billingLink && <p className="mt-1">Forme juridique, capital, RCS/RM et TVA se renseignent dans <Link href="/factures/parametres" className="underline">Factures / Paramètres</Link> ; dénomination, adresse et SIRET ci-contre.</p>}
      </div>
    </div>
  )
}
