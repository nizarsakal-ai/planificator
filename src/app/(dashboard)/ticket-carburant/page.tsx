import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { DriverFuelTicket } from "@/components/vehicules/v3/DriverFuelTicket"

export const metadata: Metadata = { title: "Ticket carburant" }

/**
 * Page chauffeur : photo du ticket au moment du plein. Le droit (chauffeur attitré du camion) est relu par
 * l'API à chaque lecture et à chaque envoi ; la page n'autorise rien par elle-même.
 */
export default async function TicketCarburantPage() {
  if (!isVehiclesV3Enabled()) notFound()
  const session = await auth()
  if (!session?.user) redirect("/login")
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Ticket carburant ou péage</h1>
        <p className="mt-1 text-sm text-slate-500">Prenez le ticket en photo juste après le plein ou le péage : le montant est lu automatiquement et le ticket est archivé comme justificatif.</p>
      </div>
      <DriverFuelTicket />
    </div>
  )
}
