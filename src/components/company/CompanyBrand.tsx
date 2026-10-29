/** Identité de la société active, résolue côté serveur par le layout. */
export function CompanyBrand({ name, logo }: { name: string; logo: string | null }) {
  if (!logo) return null
  return (
    <div className="mb-6 flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3" aria-label="Société active">
      {/* Fichier PNG validé et enregistré par le serveur, sans chargement externe. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logo} alt={`Logo ${name}`} className="h-16 w-40 object-contain object-left" />
      <p className="text-base font-semibold text-slate-900">{name}</p>
    </div>
  )
}
