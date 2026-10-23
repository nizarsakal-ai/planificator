import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Sidebar } from "@/components/layout/Sidebar"
import { Navbar } from "@/components/layout/Navbar"
import { InstallPrompt } from "@/components/pwa/InstallPrompt"
import type { Role } from "@prisma/client"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user) redirect("/login")

  const role = session.user.role as Role
  const companyId = session.user.companyId
  // Les clients ont leur propre portail
  if (role === "CLIENT") redirect("/mes-chantiers")

  // Objet utilisateur avec le rôle frais depuis la DB
  const user = { ...session.user, role, companyId }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar user={user} />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Navbar user={user} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
      <InstallPrompt />
    </div>
  )
}
