import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Sidebar } from "@/components/layout/Sidebar"
import { Navbar } from "@/components/layout/Navbar"
import { InstallPrompt } from "@/components/pwa/InstallPrompt"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  if (!session?.user) redirect("/login")

  // Relire le rôle réel depuis la DB (contourne le cache JWT)
  if (session.user.id) {
    try {
      const dbUser = await prisma.user.findUnique({
        where:  { id: session.user.id },
        select: { role: true, companyId: true },
      })
      if (dbUser) {
        session.user.role      = dbUser.role
        session.user.companyId = dbUser.companyId
      }
    } catch {
      // DB indisponible : on garde la session en cache
    }
  }

  // Les clients ont leur propre portail
  if (session.user.role === "CLIENT") redirect("/mes-chantiers")

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar fixe à gauche */}
      <Sidebar user={session.user} />

      {/* Contenu principal */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <Navbar user={session.user} />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
      <InstallPrompt />
    </div>
  )
}
