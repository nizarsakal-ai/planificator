"use client"

import { useState, type ReactNode } from "react"
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

/**
 * Formulaire de connexion (logique inchangée : même schéma, même `signIn("credentials")`, mêmes messages).
 * `passwordAside` : contenu affiché sous le mot de passe (lien « Mot de passe oublié ? »), avant le bouton.
 */
export function LoginForm({ passwordAside }: { passwordAside?: ReactNode } = {}) {
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

  const fieldClass = (invalid: boolean) =>
    `h-12 rounded-[13px] border bg-slate-50 pl-11 text-[15px] text-slate-900 placeholder:text-slate-500 transition-[border-color,box-shadow,background-color] motion-reduce:transition-none focus-visible:bg-white focus-visible:ring-4 focus-visible:ring-offset-0 ${
      invalid
        ? "border-red-400 focus-visible:ring-red-500/15"
        : "border-slate-200 focus-visible:border-blue-700 focus-visible:ring-blue-700/15 dark:focus-visible:border-blue-400"
    }`
  const labelClass = "text-[12.5px] font-semibold text-slate-700"
  const errorClass = "text-xs text-red-600 dark:text-red-300"

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="email" className={labelClass}>Adresse email</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <Input
            id="email"
            type="email"
            placeholder="vous@exemple.fr"
            autoComplete="email"
            disabled={isSubmitting}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "email-error" : undefined}
            className={fieldClass(!!errors.email)}
            {...register("email")}
          />
        </div>
        {errors.email && (
          <p id="email-error" className={errorClass}>{errors.email.message}</p>
        )}
      </div>

      {/* Mot de passe */}
      <div className="space-y-2">
        <Label htmlFor="password" className={labelClass}>Mot de passe</Label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            placeholder="••••••••"
            autoComplete="current-password"
            disabled={isSubmitting}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-error" : undefined}
            className={`${fieldClass(!!errors.password)} pr-24`}
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-pressed={showPassword}
            aria-controls="password"
            aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
            className="absolute right-1.5 top-1/2 h-9 -translate-y-1/2 rounded-lg px-3 text-xs font-semibold text-blue-700 outline-none transition-colors hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none dark:text-blue-300 dark:hover:bg-slate-100"
          >
            {showPassword ? "Masquer" : "Afficher"}
          </button>
        </div>
        {errors.password && (
          <p id="password-error" className={errorClass}>{errors.password.message}</p>
        )}
        {passwordAside && <div className="flex justify-end pt-1">{passwordAside}</div>}
      </div>

      {/* Erreur serveur */}
      {serverError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-200">
          {serverError}
        </div>
      )}

      {/* Bouton */}
      <button
        type="submit"
        disabled={isSubmitting}
        className="group mt-1 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[14px] bg-[#0f3460] text-[15px] font-semibold text-white shadow-[0_14px_28px_-14px_rgba(15,52,96,0.9)] outline-none transition-colors hover:bg-[#0b2a4f] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:bg-blue-600 dark:hover:bg-blue-500 disabled:cursor-progress disabled:opacity-80 motion-reduce:transition-none"
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
