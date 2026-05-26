import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  HardHat, Users, Calendar, BarChart3, Shield, Zap,
  CheckCircle2, ArrowRight,
} from "lucide-react"

const FEATURES = [
  { icon: Users,     title: "Gestion des équipes",      desc: "Créez vos équipes, assignez des chefs d'équipe, gérez les membres en temps réel." },
  { icon: HardHat,   title: "Gestion des chantiers",    desc: "Planifiez vos chantiers, suivez leur avancement, prolongez-les en un clic." },
  { icon: Calendar,  title: "Planning hebdomadaire",    desc: "Visualisez toutes les affectations par semaine. Détectez les conflits automatiquement." },
  { icon: BarChart3, title: "Tableaux de bord",         desc: "Statistiques claires sur vos équipes, chantiers et absences." },
  { icon: Shield,    title: "Multi-tenant sécurisé",    desc: "Chaque entreprise a son espace isolé. Accès par invitation uniquement." },
  { icon: Zap,       title: "Rapide et moderne",        desc: "Interface fluide, notifications en temps réel, accessible sur tous les écrans." },
]

const ROLES = [
  { role: "Administrateur", desc: "Vue complète sur toutes les opérations de l'entreprise." },
  { role: "Chef d'équipe",  desc: "Consulte son planning et celui de son équipe." },
  { role: "Employé",        desc: "Voit ses affectations, ses absences, son profil." },
  { role: "Client",         desc: "Portail dédié pour suivre l'avancement de ses chantiers." },
]

export default async function HomePage() {
  const session = await auth()

  // Utilisateur connecté → redirection immédiate
  if (session?.user) {
    const { role } = session.user
    if (role === "SUPER_ADMIN") redirect("/super-admin/entreprises")
    if (role === "CLIENT")      redirect("/mes-chantiers")
    redirect("/dashboard")
  }

  // Visiteur non connecté → landing page
  return (
    <div className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="border-b border-slate-100 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#0f3460] text-white flex items-center justify-center font-bold text-sm">P</div>
            <span className="font-bold text-slate-900">Planificator</span>
          </div>
          <Link href="/login">
            <Button className="bg-[#0f3460] hover:bg-[#0a2540]">Se connecter</Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-20 text-center">
        <Badge className="mb-6 bg-blue-50 text-[#0f3460] border-blue-100 text-xs px-3 py-1">
          Planning d&apos;équipes BTP
        </Badge>
        <h1 className="text-5xl font-bold text-slate-900 leading-tight mb-6">
          Gérez vos équipes et<br />chantiers en toute simplicité
        </h1>
        <p className="text-xl text-slate-500 max-w-2xl mx-auto mb-10">
          Planificator centralise la gestion de vos employés, équipes, clients et chantiers dans une interface moderne et intuitive.
        </p>
        <Link href="/login">
          <Button size="lg" className="bg-[#0f3460] hover:bg-[#0a2540] gap-2">
            Accéder à l&apos;application <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
        <p className="text-xs text-slate-400 mt-4">Accès sur invitation — sécurisé par entreprise</p>
      </section>

      {/* Features */}
      <section className="bg-slate-50 py-20">
        <div className="max-w-6xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-slate-900 text-center mb-12">Tout ce dont vous avez besoin</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-white rounded-2xl p-6 border border-slate-100 hover:shadow-md transition-shadow">
                <div className="w-10 h-10 rounded-xl bg-[#0f3460]/10 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-[#0f3460]" />
                </div>
                <h3 className="font-semibold text-slate-900 mb-2">{f.title}</h3>
                <p className="text-sm text-slate-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Rôles */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-slate-900 text-center mb-4">Un accès adapté à chaque rôle</h2>
        <p className="text-slate-500 text-center mb-12">Chaque utilisateur voit uniquement ce dont il a besoin.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl mx-auto">
          {ROLES.map((r) => (
            <div key={r.role} className="flex items-start gap-3 p-4 rounded-xl border border-slate-100">
              <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-slate-800 text-sm">{r.role}</p>
                <p className="text-xs text-slate-500 mt-0.5">{r.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#0f3460] py-16">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Prêt à organiser vos chantiers ?</h2>
          <p className="text-slate-300 mb-8">
            Connectez-vous avec vos identifiants ou demandez une invitation à votre administrateur.
          </p>
          <Link href="/login">
            <Button size="lg" className="bg-white text-[#0f3460] hover:bg-slate-100 gap-2">
              Se connecter <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-8 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} Planificator · Gestion de planning d&apos;équipes
      </footer>
    </div>
  )
}
