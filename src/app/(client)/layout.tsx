import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { ClientHeader } from "@/components/client/ClientHeader"
import { CopilotPanel } from "@/components/copilot/CopilotPanel"
import { copilotConfig } from "@/lib/copilot/copilot-config"
import { isCopilotRoleAllowed } from "@/lib/copilot/copilot-roles"

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "CLIENT") redirect("/dashboard")
  // IA-6 : assistant du portail client, seulement si le rôle CLIENT est ouvert (COPILOT_ROLES) et la société ciblée.
  const copilotVisible = isCopilotRoleAllowed("CLIENT") && copilotConfig(session.user.companyId) !== null

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientHeader name={session.user.name ?? session.user.email ?? ""} />
      <main className="max-w-4xl mx-auto p-6">{children}</main>
      {copilotVisible && <CopilotPanel audience="client" launcher />}
    </div>
  )
}
