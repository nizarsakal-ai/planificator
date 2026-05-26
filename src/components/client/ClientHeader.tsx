"use client"

import { signOut } from "next-auth/react"

export function ClientHeader({ name }: { name: string }) {
  return (
    <header className="bg-[#0f3460] text-white px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-white text-[#0f3460] flex items-center justify-center font-bold text-sm">
          P
        </div>
        <div>
          <p className="font-bold text-sm leading-tight">Planificator</p>
          <p className="text-slate-400 text-[11px]">Portail client</p>
        </div>
      </div>
      <div className="flex items-center gap-4">
        <p className="text-sm text-slate-300">{name}</p>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-xs text-slate-400 hover:text-white transition-colors"
        >
          Déconnexion
        </button>
      </div>
    </header>
  )
}
