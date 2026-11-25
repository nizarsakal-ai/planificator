import Link from "next/link"
import { LegalLinks } from "@/components/legal/LegalDocumentView"

// Lot 2a juridique : pages légales publiques (connecté ou non), sans barre latérale.
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link href="/" className="text-base font-bold text-[#0f3460]">Planificator</Link>
          <Link href="/login" className="text-sm text-slate-600 underline-offset-2 hover:underline">Retour à l&apos;application</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</article>
        <LegalLinks className="mt-6" />
      </main>
    </div>
  )
}
