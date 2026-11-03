import Link from "next/link"
import { Instrument_Serif } from "next/font/google"
import { PlanificatorMark } from "@/components/brand/PlanificatorLogo"
import { LoginForm } from "@/components/auth/LoginForm"

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], display: "swap" })

// Grille décorative 7 × 6 (une semaine par ligne) : cases mises en avant et leur intensité.
const HIGHLIGHTS: Record<number, string> = {
  3: "bg-blue-400/30", 9: "bg-blue-400/20", 10: "bg-blue-400/25", 16: "bg-blue-400/20",
  24: "bg-blue-400/30", 25: "bg-blue-400/20", 26: "bg-blue-400/25", 31: "bg-blue-400/20", 38: "bg-blue-400/25",
}

/**
 * Page de connexion « bleu nuit éditorial » : titre éditorial et grille de semaine décorative sur bleu nuit
 * Planificator, formulaire dans une carte claire. Seul l'habillage change : formulaire, liens et routes identiques.
 * La carte suit Apparence (`data-appearance-scope`) ; le fond bleu nuit est identique dans les deux thèmes.
 */
export function LoginExperience() {
  return (
    // Pleine page : annule le cadrage centré du layout d'authentification (p-4).
    <div className="relative -m-4 flex min-h-[100dvh] flex-1 flex-col self-stretch overflow-hidden bg-[linear-gradient(160deg,#0f3460_0%,#0a2447_70%)] md:flex-row">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_50%_at_15%_10%,rgba(96,165,250,0.25),transparent_70%)]"
        aria-hidden="true"
      />

      <section className="relative flex flex-col px-5 pb-6 pt-5 text-white sm:px-10 sm:pt-8 md:flex-1 md:px-14 md:py-10">
        <div className="flex items-center gap-2.5">
          <PlanificatorMark className="h-8 w-8" />
          <span className="text-[15px] font-bold tracking-tight">Planificator</span>
        </div>

        <div className="mt-6 md:my-auto md:pt-10">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-300">Chantiers &amp; équipes</p>
          <p className={`${serif.className} mt-3 max-w-[36rem] text-[40px] leading-[0.98] sm:text-[52px] lg:text-[66px]`}>
            Chaque équipe, <em className="text-blue-300">au bon endroit,</em> au bon moment.
          </p>
          <div className="mt-11 hidden grid-cols-[repeat(7,46px)] auto-rows-[34px] gap-1.5 md:grid" aria-hidden="true">
            {Array.from({ length: 42 }, (_, i) => (
              <span key={i} className={`rounded-[10px] border border-white/[0.08] ${HIGHLIGHTS[i] ?? ""}`} />
            ))}
          </div>
        </div>
      </section>

      <section
        data-appearance-scope=""
        className="relative mx-3 mb-3 flex flex-col justify-center rounded-[24px] bg-white px-5 py-7 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.6)] sm:mx-8 sm:px-10 md:m-[18px] md:w-[460px] md:shrink-0 md:rounded-[28px] md:px-12 lg:w-[500px] lg:px-14"
      >
        <h1 className={`${serif.className} text-[38px] leading-none text-slate-900 sm:text-[44px]`}>Connexion</h1>
        <p className="mb-7 mt-2.5 text-[14.5px] text-slate-600">Retrouvez vos chantiers et vos équipes.</p>

        <LoginForm
          passwordAside={
            <Link href="/mot-de-passe-oublie" className="rounded text-[13px] font-semibold text-blue-700 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300">
              Mot de passe oublié ?
            </Link>
          }
        />

        <div className="my-6 flex items-center gap-3 text-xs text-slate-500">
          <span className="h-px flex-1 bg-slate-200" />
          Nouvelle entreprise ?
          <span className="h-px flex-1 bg-slate-200" />
        </div>
        <Link
          href="/inscription"
          className="flex h-12 items-center justify-center rounded-[14px] border border-slate-200 text-sm font-semibold text-slate-900 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none"
        >
          Créer mon entreprise
        </Link>
      </section>
    </div>
  )
}
