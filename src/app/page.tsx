import { auth } from "@/auth"
import { redirect } from "next/navigation"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

// Page d'accueil publique : une porte d'entrée, pas une plaquette commerciale. L'accès se fait sur invitation,
// donc la page dit ce qu'est l'outil, montre son objet (le planning de la semaine) et mène à la connexion.

/** Couleurs des statuts de chantier, identiques à celles du tableau de bord. */
const STATUS = {
  PLANNED: { label: "Planifié", bar: "bg-slate-300 text-slate-800" },
  IN_PROGRESS: { label: "En cours", bar: "bg-[#0f3460] text-white" },
  EXTENDED: { label: "Prolongé", bar: "bg-amber-500 text-amber-950" },
} as const

type Status = keyof typeof STATUS

/** Semaine d'exemple : chaque équipe, ses chantiers, jour de début (0 = lundi) et durée en jours ouvrés. */
const WEEK: ReadonlyArray<{ team: string; jobs: ReadonlyArray<{ name: string; start: number; days: number; status: Status }> }> = [
  { team: "Montage A", jobs: [{ name: "Marché de Noël · tentes 6 × 12", start: 0, days: 3, status: "IN_PROGRESS" }, { name: "Démontage gymnase", start: 3, days: 2, status: "PLANNED" }] },
  { team: "Montage B", jobs: [{ name: "Tribune télescopique · 400 places", start: 0, days: 5, status: "EXTENDED" }] },
  { team: "Technique", jobs: [{ name: "Son et lumière · salle des fêtes", start: 1, days: 2, status: "IN_PROGRESS" }, { name: "Photobooth", start: 4, days: 1, status: "PLANNED" }] },
  { team: "Livraison", jobs: [{ name: "Chaises", start: 0, days: 1, status: "IN_PROGRESS" }, { name: "Retour dépôt", start: 2, days: 1, status: "PLANNED" }, { name: "Moquette · 300 m²", start: 3, days: 2, status: "PLANNED" }] },
]

const ROLES = [
  { role: "Administrateur", text: "Chantiers, planning, devis, factures, matériel et stock de l'entreprise." },
  { role: "Chef d'équipe", text: "Le planning de son équipe et les rapports de fin de journée." },
  { role: "Employé", text: "Ses affectations, ses pointages, ses absences et ses documents." },
  { role: "Client", text: "L'avancement de ses chantiers et ses devis à signer." },
]

/** Lundi à vendredi de la semaine en cours (heure de Paris), et l'index du jour courant (-1 le week-end). */
function currentWeek(now: Date) {
  const paris = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }))
  const dow = (paris.getDay() + 6) % 7
  const monday = new Date(paris)
  monday.setDate(paris.getDate() - dow)
  const days = Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return {
      weekday: new Intl.DateTimeFormat("fr-FR", { weekday: "short" }).format(d).replace(".", ""),
      day: d.getDate(),
    }
  })
  return { days, today: dow < 5 ? dow : -1 }
}

function WeekBoard() {
  const { days, today } = currentWeek(new Date())
  return (
    <figure className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[104px_repeat(5,minmax(0,1fr))]">
          {/* En-tête des jours */}
          <div className="border-b border-slate-200" />
          {days.map((d, i) => (
            <div
              key={i}
              aria-current={i === today ? "date" : undefined}
              className={`border-b border-l border-slate-200 px-2 py-2 text-xs ${i === today ? "bg-[#0f3460]/[0.04] text-[#0f3460]" : "text-slate-500"}`}
            >
              <span className="capitalize">{d.weekday}</span>{" "}
              <span className={`tabular-nums ${i === today ? "font-semibold" : ""}`}>{d.day}</span>
            </div>
          ))}

          {/* Une ligne par équipe ; les chantiers s'étendent sur leurs jours */}
          {WEEK.map((row) => (
            <div key={row.team} className="contents">
              <div className="flex items-center border-b border-slate-100 whitespace-nowrap px-3 py-3 text-[13px] font-medium text-slate-700">
                {row.team}
              </div>
              <div className="relative col-span-5 grid grid-cols-5 border-b border-slate-100">
                {days.map((_, i) => (
                  <div key={i} className={`border-l border-slate-100 ${i === today ? "bg-[#0f3460]/[0.04]" : ""}`} />
                ))}
                <div className="absolute inset-0 grid grid-cols-5 items-center gap-y-1 px-1 py-2">
                  {row.jobs.map((j) => (
                    <div
                      key={j.name}
                      style={{ gridColumn: `${j.start + 1} / span ${j.days}` }}
                      className={`mx-0.5 truncate rounded-md px-2 py-1.5 text-[12px] font-medium ${STATUS[j.status].bar}`}
                      title={`${j.name} · ${STATUS[j.status].label}`}
                    >
                      {j.name}
                    </div>
                  ))}
                </div>
                <div aria-hidden className="h-12" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-200 px-3 py-2.5 text-xs text-slate-500">
        <span>Exemple de semaine · colonne teintée : aujourd&apos;hui</span>
        {(Object.keys(STATUS) as Status[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-sm ${STATUS[s].bar.split(" ")[0]}`} />
            {STATUS[s].label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

export default async function HomePage() {
  const session = await auth()

  // Utilisateur connecté → redirection immédiate
  if (session?.user) {
    const { role } = session.user
    if (role === "SUPER_ADMIN") redirect("/super-admin/entreprises")
    if (role === "CLIENT") redirect("/mes-chantiers")
    redirect("/dashboard")
  }

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 md:px-8">
        <span className="text-[17px] font-semibold tracking-tight">Planificator</span>
        <Link
          href="/login"
          className="rounded-lg px-3 py-2 text-sm font-medium text-[#0f3460] outline-none hover:bg-[#0f3460]/5 focus-visible:ring-2 focus-visible:ring-[#0f3460]"
        >
          Se connecter
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-5 pb-16 md:px-8">
        <section className="grid gap-10 pt-6 md:pt-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-14">
          <div>
            <h1 className="text-[36px] font-semibold leading-[1.08] tracking-[-0.02em] md:text-[48px]">
              Qui va où, avec quel matériel, cette semaine.
            </h1>
            <p className="mt-5 max-w-md text-[17px] leading-relaxed text-slate-600">
              Planificator réunit le planning des équipes, les chantiers et événements, le matériel loué, les devis et
              les factures d&apos;une entreprise de montage et de location.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-[#0f3460] px-5 py-3 text-[15px] font-semibold text-white outline-none hover:bg-[#0a2540] focus-visible:ring-2 focus-visible:ring-[#0f3460] focus-visible:ring-offset-2"
              >
                Se connecter <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <p className="text-sm text-slate-500">Accès sur invitation de votre entreprise.</p>
            </div>
          </div>

          <WeekBoard />
        </section>

        <section className="mt-20 border-t border-slate-200 pt-8" aria-labelledby="roles">
          <h2 id="roles" className="text-[15px] font-semibold">Ce que chacun retrouve après connexion</h2>
          <dl className="mt-5 grid gap-x-10 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((r) => (
              <div key={r.role}>
                <dt className="text-sm font-medium">{r.role}</dt>
                <dd className="mt-1 text-sm leading-relaxed text-slate-600">{r.text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-sm text-slate-500">
            Pas encore de compte ? Demandez une invitation à l&apos;administrateur de votre entreprise.
          </p>
        </section>
      </main>

      <footer className="mx-auto max-w-6xl border-t border-slate-100 px-5 py-6 text-xs text-slate-400 md:px-8">
        © {new Date().getFullYear()} Planificator
      </footer>
    </div>
  )
}
