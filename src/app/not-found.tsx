import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="text-center space-y-6 max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-[#0f3460] text-white flex items-center justify-center font-bold text-2xl mx-auto">
          P
        </div>
        <div>
          <h1 className="text-6xl font-bold text-slate-200">404</h1>
          <h2 className="text-xl font-semibold text-slate-800 mt-2">Page introuvable</h2>
          <p className="text-slate-500 text-sm mt-2">
            La page que vous cherchez n&apos;existe pas ou a été déplacée.
          </p>
        </div>
        <Link href="/dashboard">
          <Button className="bg-[#0f3460] hover:bg-[#0a2540]">
            Retour au dashboard
          </Button>
        </Link>
      </div>
    </div>
  )
}
