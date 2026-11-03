"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { ArrowRight, Loader2, LockKeyhole, Mail } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const loginSchema = z.object({
  email: z
    .string()
    .min(1, "L'email est requis")
    .email("Format d'email invalide"),
  password: z.string().min(1, "Le mot de passe est requis"),
})

type LoginFormData = z.infer<typeof loginSchema>

export type LoginField = "email" | "password"

/**
 * Formulaire de connexion (logique inchangée : même schéma, même `signIn("credentials")`, mêmes messages).
 * Les rappels optionnels signalent seulement QUEL champ a le focus et si le mot de passe est affiché, pour
 * l'illustration décorative ; ils ne transmettent jamais la valeur des champs.
 */
export function LoginForm({
  onFieldFocus,
  onPasswordVisibilityChange,
}: {
  onFieldFocus?: (field: LoginField | null) => void
  onPasswordVisibilityChange?: (visible: boolean) => void
} = {}) {
  const router = useRouter()
  const [showPassword, setShowPassword] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  const onSubmit = async (data: LoginFormData) => {
    setServerError(null)

    try {
      const result = await signIn("credentials", {
        email: data.email,
        password: data.password,
        redirect: false,
      })

      if (result?.error) {
        setServerError("Email ou mot de passe incorrect.")
        return
      }

      if (result?.ok) {
        // Redirige vers "/" qui redirigera selon le rôle
        router.push("/")
        router.refresh()
      }
    } catch {
      setServerError("Une erreur est survenue. Veuillez réessayer.")
    }
  }

  const emailField = register("email")
  const passwordField = register("password")
  const togglePassword = () => {
    const next = !showPassword
    setShowPassword(next)
    onPasswordVisibilityChange?.(next)
  }
  const fieldClass = (invalid: boolean) =>
    `h-12 rounded-xl border bg-white/[0.06] pl-11 text-[15px] text-white placeholder:text-white/70 transition-[border-color,box-shadow] motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-sky-300/60 focus-visible:ring-offset-0 ${
      invalid ? "border-red-300/70" : "border-white/15 focus-visible:border-sky-300/70"
    }`

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="email" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75">Adresse email</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/55" aria-hidden="true" />
          <Input
            id="email"
            type="email"
            placeholder="vous@exemple.fr"
            autoComplete="email"
            disabled={isSubmitting}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "email-error" : undefined}
            className={fieldClass(!!errors.email)}
            {...emailField}
            onFocus={() => onFieldFocus?.("email")}
            onBlur={(event) => { void emailField.onBlur(event); onFieldFocus?.(null) }}
          />
        </div>
        {errors.email && (
          <p id="email-error" className="text-xs text-red-200">{errors.email.message}</p>
        )}
      </div>

      {/* Mot de passe */}
      <div className="space-y-2">
        <Label htmlFor="password" className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/75">Mot de passe</Label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-white/55" aria-hidden="true" />
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={isSubmitting}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-error" : undefined}
            className={`${fieldClass(!!errors.password)} pr-24`}
            {...passwordField}
            onFocus={() => onFieldFocus?.("password")}
            onBlur={(event) => { void passwordField.onBlur(event); onFieldFocus?.(null) }}
          />
          <button
            type="button"
            onClick={togglePassword}
            aria-pressed={showPassword}
            aria-controls="password"
            aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
            className="absolute right-1.5 top-1/2 h-9 -translate-y-1/2 rounded-lg px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white/80 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-300/70 motion-reduce:transition-none"
          >
            {showPassword ? "Masquer" : "Afficher"}
          </button>
        </div>
        {errors.password && (
          <p id="password-error" className="text-xs text-red-200">{errors.password.message}</p>
        )}
      </div>

      {/* Erreur serveur */}
      {serverError && (
        <div role="alert" className="rounded-xl border border-red-300/30 bg-red-500/15 p-3 text-sm text-red-100">
          {serverError}
        </div>
      )}

      {/* Bouton */}
      <button
        type="submit"
        disabled={isSubmitting}
        className="group inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white text-[15px] font-semibold text-[#0f3460] shadow-[0_12px_28px_-14px_rgba(0,0,0,0.6)] outline-none transition-colors hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f3460] disabled:cursor-progress disabled:opacity-80 motion-reduce:transition-none"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Connexion en cours…
          </>
        ) : (
          <>
            Se connecter
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" aria-hidden="true" />
          </>
        )}
      </button>
    </form>
  )
}
