import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { ClientHeader } from "@/components/client/ClientHeader"

export default async function ClientLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (session.user.role !== "CLIENT") redirect("/dashboard")

  return (
    <div className="min-h-screen bg-slate-50">
      <ClientHeader name={session.user.name ?? session.user.email ?? ""} />
      <main className="max-w-4xl mx-auto p-6">{children}</main>
    </div>
  )
}
