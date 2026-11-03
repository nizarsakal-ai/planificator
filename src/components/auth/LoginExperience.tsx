"use client"

import { useState } from "react"
import Link from "next/link"
import { Instrument_Serif } from "next/font/google"
import { PlanificatorMark } from "@/components/brand/PlanificatorLogo"
import { LoginCrew } from "@/components/auth/LoginCrew"
import { LoginForm, type LoginField } from "@/components/auth/LoginForm"

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: "italic", display: "swap" })

/**
 * Page de connexion « deux tons » : moitié claire (marque + illustration décorative), moitié bleu nuit Planificator
 * (formulaire dans une carte en arche). Seul l'habillage change : formulaire, liens et routes identiques.
 * La moitié claire suit Apparence (`data-appearance-scope`) ; la moitié bleu nuit est identique dans les deux thèmes.
 */
export function LoginExperience() {
  const [focusedField, setFocusedField] = useState<LoginField | null>(null)
  const [passwordVisible, setPasswordVisible] = useState(false)

  return (
    // Pleine page : annule le cadrage centré du layout d'authentification (p-4).
    <div className="-m-4 flex min-h-[100dvh] flex-1 flex-col self-stretch md:flex-row">
      <section
        data-appearance-scope=""
        className="relative flex flex-col overflow-hidden bg-white px-5 pb-2 pt-5 sm:px-10 sm:pb-4 sm:pt-6 md:w-[52%] md:px-12 md:pb-10 md:pt-9 lg:px-16"
      >
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgb(var(--slate-300)/0.55)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-2.5">
          <PlanificatorMark className="h-8 w-8" />
          <span className="text-[15px] font-bold tracking-tight text-slate-900">Planificator</span>
        </div>

        <div className="relative mt-5 sm:mt-8 md:mt-auto">
          <p className="hidden text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 sm:block">Planning d&apos;équipes</p>
          <p className="text-[32px] font-extrabold sm:mt-3 leading-[0.95] tracking-[-0.04em] text-slate-900 sm:text-5xl lg:text-[64px]">
            Bonjour,
            <span className={`${serif.className} mt-1 block text-[36px] font-normal tracking-[-0.01em] text-blue-600 sm:text-[52px] lg:text-[70px] dark:text-blue-300`}>
              ravi de vous revoir.
            </span>
          </p>
          <p className="mt-4 hidden max-w-[26rem] text-[14.5px] leading-relaxed text-slate-600 sm:block">
            L&apos;équipe de chantier vous suit des yeux… et promet de ne pas regarder votre mot de passe.
          </p>
        </div>

        <LoginCrew
          focusedField={focusedField}
          passwordVisible={passwordVisible}
          className="relative mx-auto mt-3 max-w-[220px] sm:mt-6 sm:max-w-[300px] md:hidden"
          layout="stacked"
        />
        <LoginCrew
          focusedField={focusedField}
          passwordVisible={passwordVisible}
          className="relative mt-10 hidden max-w-[540px] md:mb-auto md:block"
          layout="side"
        />
      </section>

      <section className="relative flex flex-1 items-start justify-center overflow-hidden bg-[#0f3460] px-4 py-6 sm:items-center sm:px-8 sm:py-10">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_60%_at_85%_110%,rgba(59,108,246,0.45),transparent_60%),radial-gradient(60%_45%_at_0%_-10%,rgba(34,184,230,0.18),transparent_60%)]"
          aria-hidden="true"
        />
        <div className="relative w-full max-w-[400px] rounded-b-[28px] rounded-t-[170px] border border-white/[0.12] bg-white/[0.045] px-5 pb-6 pt-11 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-md sm:rounded-t-[200px] sm:px-8 sm:pt-16">
          <div className="mb-6 text-center sm:mb-7">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-200/80">Espace équipe</p>
            <h1 className="mt-2 text-[28px] font-bold tracking-[-0.03em] text-white">Connexion</h1>
            <p className="mt-1.5 text-sm text-white/70">Entrez vos identifiants pour accéder à votre espace.</p>
          </div>

          <LoginForm onFieldFocus={setFocusedField} onPasswordVisibilityChange={setPasswordVisible} />

          <div className="mt-6 flex flex-col items-center gap-2 text-[13px] text-white/70">
            <Link href="/mot-de-passe-oublie" className="rounded font-medium text-sky-200 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-sky-300/70">
              Mot de passe oublié ?
            </Link>
            <p>
              Nouvelle entreprise ?{" "}
              <Link href="/inscription" className="rounded font-semibold text-white underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-sky-300/70">
                Créer mon entreprise
              </Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
