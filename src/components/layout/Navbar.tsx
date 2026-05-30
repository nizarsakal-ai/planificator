import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { getInitials } from "@/lib/utils"
import { NotificationBell } from "@/components/notifications/NotificationBell"
import { MobileNav } from "@/components/layout/MobileNav"
import type { Role } from "@prisma/client"

interface NavbarUser {
  id: string
  name?: string | null
  email?: string | null
  image?: string | null
  role: Role
  companyId: string | null
}

export function Navbar({ user }: { user: NavbarUser }) {
  return (
    <header className="h-14 bg-white border-b border-slate-200 px-4 md:px-6 flex items-center justify-between shrink-0">
      {/* Hamburger (mobile) */}
      <MobileNav user={user} />

      {/* Spacer sur desktop */}
      <div className="hidden md:block" />

      {/* Actions */}
      <div className="flex items-center gap-3">
        <NotificationBell />

        {/* Avatar */}
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={user.image ?? undefined} />
            <AvatarFallback className="bg-[#0f3460] text-white text-xs font-medium">
              {getInitials(user.name ?? user.email ?? "?")}
            </AvatarFallback>
          </Avatar>
          <div className="hidden sm:block">
            <p className="text-xs font-medium text-slate-700 leading-tight">
              {user.name ?? user.email}
            </p>
          </div>
        </div>
      </div>
    </header>
  )
}
