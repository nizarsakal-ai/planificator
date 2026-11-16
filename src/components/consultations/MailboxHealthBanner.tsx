import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import {
  acquisitionGmailReconnectUrl,
  mailboxNeedsReconnect,
} from "@/lib/acquisition/connector/acquisition-mailbox-health"
import type { AcquisitionMailboxStatus } from "@/lib/acquisition/connector/acquisition-mailbox-health.repository"

/**
 * Alerte visible là où l'on attend les consultations : une boîte Gmail en échec
 * ne doit plus passer inaperçue (incident 03→16/11/2026).
 */
export function MailboxHealthBanner({ mailboxes }: { mailboxes: AcquisitionMailboxStatus[] }) {
  const broken = mailboxes.filter((m) => mailboxNeedsReconnect(m.health))
  if (broken.length === 0) return null

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 space-y-2">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        Les nouvelles consultations ne sont plus importées
      </div>
      <ul className="space-y-2">
        {broken.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Gmail refuse l&apos;accès à <strong className="font-mono">{m.gmailAddress}</strong>.
              {m.health.hint ? ` ${m.health.hint}` : ""}
            </span>
            {/* Lien natif (pas de prefetch) : redirection OAuth Google. */}
            <a
              href={acquisitionGmailReconnectUrl(m.gmailAddress)}
              className="shrink-0 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Reconnecter
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-red-700">
        Sur l&apos;écran Google, cochez bien « Lire vos e-mails Gmail ».{" "}
        <Link href="/parametres" className="underline">Voir les boîtes</Link>
      </p>
    </div>
  )
}
