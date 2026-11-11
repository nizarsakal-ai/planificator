import Link from "next/link"

/**
 * Refus rendu sur place pour un rôle ou une société non habilités aux modules réservés aux administrateurs (stocks et
 * achats ; matériel et location). Aucune donnée métier, aucune redirection pendant le rendu (React #310 constaté en VM B r4).
 * Même forme que le refus Employés de la V1 (main 120bf8c4).
 */
export function AdminOnlyNotice() {
  return (
    <div role="alert" data-acces-refuse="" className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-800">
      <p>Cette page est réservée aux administrateurs de la société.</p>
      <Link href="/dashboard" className="mt-2 inline-block text-blue-700 underline">Retour au tableau de bord</Link>
    </div>
  )
}
