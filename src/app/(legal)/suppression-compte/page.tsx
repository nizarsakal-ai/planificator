import type { Metadata } from "next"
import Link from "next/link"
import { privacyContactEmail } from "@/lib/legal/legal-documents"

// Lot 2b juridique : page web publique de demande de suppression de compte (Google Play : accessible sans
// l'application, sans téléchargement, avec le nom de l'application). Statique : l'adresse est lue au build.
export const dynamic = "force-static"
export const metadata: Metadata = { title: "Suppression de compte" }

export default function SuppressionComptePage() {
  const contact = privacyContactEmail()
  const mailto = contact
    ? `mailto:${contact}?subject=${encodeURIComponent("Planificator - demande de suppression de compte")}`
    : null
  return (
    <div className="space-y-6 text-sm leading-relaxed text-slate-700">
      <h1 className="text-2xl font-bold text-slate-900">Supprimer votre compte Planificator</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Depuis l&apos;application</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Connectez-vous à Planificator.</li>
          <li>Ouvrez <strong>Mon profil</strong>.</li>
          <li>Dans « Mes données et mon compte », choisissez <strong>Supprimer mon compte</strong>.</li>
          <li>Saisissez votre mot de passe et tapez SUPPRIMER pour confirmer.</li>
        </ol>
        <p>La suppression est immédiate. Depuis la même page, vous pouvez d&apos;abord télécharger une copie de vos données.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Sans accès à l&apos;application</h2>
        <p>
          Si vous ne pouvez plus vous connecter, ou si vous êtes le dernier administrateur d&apos;une société et souhaitez
          fermer tout son espace, envoyez-nous une demande depuis l&apos;adresse e-mail de votre compte. Indiquez le nom de
          la société. Nous traitons la demande sous 30 jours au plus et vous confirmons la suppression par e-mail.
        </p>
        {mailto ? (
          <p>
            <a href={mailto} className="inline-flex items-center rounded-lg bg-[#0f3460] px-4 py-2 font-medium text-white hover:bg-[#0f3460]/90">
              Demander la suppression par e-mail
            </a>
            <span className="ml-3 text-slate-500">{contact}</span>
          </p>
        ) : (
          <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
            Adresse de contact en cours de configuration.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Ce qui est supprimé, ce qui est conservé</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Supprimés :</strong> votre accès, votre adresse e-mail, votre nom de compte, votre téléphone, votre photo, vos notifications.</li>
          <li>
            <strong>Conservés par votre employeur ou la société cliente</strong>, pour les durées fixées par la loi : heures de
            travail (5 ans), documents de paie (5 ans), notes de frais et factures (10 ans). Les positions GPS des pointages
            sont effacées au bout de 2 mois.
          </li>
          <li>À la fermeture de l&apos;espace d&apos;une société, ses données sont exportables pendant 30 jours, puis effacées.</li>
        </ul>
        <p>
          Détails : <Link href="/confidentialite" className="text-blue-700 underline">politique de confidentialité</Link>.
        </p>
      </section>
    </div>
  )
}
