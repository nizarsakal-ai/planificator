"use client"

import { signOut } from "next-auth/react"
import { LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"

export function SignOutButton() {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="text-slate-500 hover:text-slate-700 gap-2"
    >
      <LogOut className="h-4 w-4" />
      Déconnexion
    </Button>
  )
}
