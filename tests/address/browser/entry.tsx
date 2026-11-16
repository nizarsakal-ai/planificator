import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { ClientForm } from "@/components/clients/ClientForm"
import { ChantierForm } from "@/components/chantiers/ChantierForm"
import { ChantierEditForm } from "@/components/chantiers/ChantierEditForm"

const clients = [{ id: "c1", name: "Mairie d'Alzonne" }]
function App() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: 16, display: "grid", gap: 32 }}>
      <section data-testid="client-create"><h2>Nouveau client</h2><ClientForm onSuccess={() => {}} /></section>
      <section data-testid="client-edit"><h2>Modifier client</h2>
        <ClientForm onSuccess={() => {}} client={{ id: "c1", name: "Mairie d'Alzonne", email: null, phone: null, address: "Place de la Mairie, 11170 Alzonne", notes: null }} />
      </section>
      <section data-testid="chantier-create"><h2>Nouveau chantier</h2><ChantierForm clients={clients} initialClientId="c1" onSuccess={() => {}} /></section>
      <section data-testid="chantier-edit"><h2>Modifier chantier</h2>
        <ChantierEditForm worksiteId="w1" clients={clients} coordinates={{ latitude: null, longitude: null }}
          defaultValues={{ name: "Arena", description: "", address: "Rue du Boulodrome, 11170 Alzonne", clientId: "c1", startDate: "2026-11-20", endDate: "2026-11-27", dailyHours: 10 }} />
      </section>
      <Toaster />
    </main>
  )
}
createRoot(document.getElementById("root")!).render(<App />)
