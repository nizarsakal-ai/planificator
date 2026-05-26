import type { Metadata } from "next"
import Link from "next/link"
import { LoginForm } from "@/components/auth/LoginForm"

export const metadata: Metadata = {
  title: "Connexion",
}

export default function LoginPage() {
  return (
    <div className="w-full max-w-md">
      {/* Logo + Branding */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#0f3460] text-white text-2xl font-bold mb-4 shadow-lg">
          P
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Planificator</h1>
        <p className="text-slate-500 mt-1 text-sm">
          Gestion de planning d&apos;équipes
        </p>
      </div>

      {/* Formulaire */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h2 className="text-xl font-semibold text-slate-800 mb-1">
          Connexion
        </h2>
        <p className="text-sm text-slate-500 mb-6">
          Entrez vos identifiants pour accéder à votre espace.
        </p>
        <LoginForm />
      </div>

      <p className="text-center text-xs text-slate-400 mt-6">
        Accès sur invitation uniquement. ·{" "}
        <Link href="/mot-de-passe-oublie" className="text-[#0f3460] underline">
          Mot de passe oublié ?
        </Link>
      </p>
    </div>
  )
}
