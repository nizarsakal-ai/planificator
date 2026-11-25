import { LegalLinks } from "@/components/legal/LegalDocumentView"

// Layout des pages d'authentification — pas de sidebar, fond neutre centré
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex flex-col items-center justify-center gap-6 p-4">
      {children}
      {/* Lot 2a juridique : mentions légales, confidentialité et CGU accessibles avant connexion. */}
      <LegalLinks />
    </div>
  )
}
