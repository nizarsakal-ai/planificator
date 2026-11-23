"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Bell, CheckCheck, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getNotifications, markAllAsRead, markAsRead } from "@/lib/actions/notification.actions"
import { destinationNotification } from "@/components/notifications/notification-lien"
import { chargerSiEnLigne, ecouterRetourReseau, rechargementPwaSurDashboard } from "@/components/notifications/notifications-reseau"

interface Notification {
  id: string
  title: string
  message: string
  read: boolean
  readAt: Date | null
  createdAt: Date
  type: string
  link: string | null
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen]                   = useState(false)
  const [, startTransition]               = useTransition()
  const router                            = useRouter()

  const unread = notifications.filter((n) => !n.read).length

  const charger = async () => {
    const data = await getNotifications()
    setNotifications(data as unknown as Notification[])
  }
  // Hors réseau, l'action serveur n'est pas tentée ; une erreur en ligne reste visible (promesse non interceptée).
  const load = () => chargerSiEnLigne(charger, typeof navigator === "undefined" ? null : navigator)

  useEffect(() => {
    load()
    // DG02 : sur /dashboard avec next-pwa actif, la page est déjà rechargée au retour du réseau ; le nouveau document relit au montage.
    return ecouterRetourReseau(window, () => { if (rechargementPwaSurDashboard(window)) return; load() })
  }, [])

  const handleOpen = (v: boolean) => {
    setOpen(v)
    if (v) load()
  }

  const handleMarkAll = () => {
    startTransition(async () => {
      await markAllAsRead()
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true, readAt: n.readAt ?? new Date() })))
    })
  }

  const handleRead = (id: string) => {
    startTransition(async () => {
      await markAsRead(id)
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true, readAt: new Date() } : n))
    })
  }

  // Clic : marque lue puis ouvre la page concernée (la navigation n'attend pas l'écriture serveur).
  const handleClick = (n: Notification) => {
    if (!n.read) handleRead(n.id)
    const destination = destinationNotification(n)
    if (destination) {
      setOpen(false)
      router.push(destination)
    }
  }

  const timeAgo = (date: Date) => {
    const diff = Date.now() - new Date(date).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1)  return "À l'instant"
    if (m < 60) return `il y a ${m}min`
    const h = Math.floor(m / 60)
    if (h < 24) return `il y a ${h}h`
    return `il y a ${Math.floor(h / 24)}j`
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-9 w-9 border border-[#0f3460]/15 bg-white text-[#0f3460] shadow-[0_2px_4px_rgba(15,52,96,0.12),0_10px_20px_-10px_rgba(15,52,96,0.55)] hover:bg-[#0f3460]/[0.04] hover:text-[#0f3460] hover:shadow-[0_3px_6px_rgba(15,52,96,0.16),0_14px_26px_-10px_rgba(15,52,96,0.65)]">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-bold">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-6 text-xs text-slate-500 px-2" onClick={handleMarkAll}>
              <CheckCheck className="h-3.5 w-3.5 mr-1" /> Tout lire
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {notifications.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">Aucune notification</div>
        ) : (
          notifications.slice(0, 8).map((n) => {
            const destination = destinationNotification(n)
            return (
            <DropdownMenuItem
              key={n.id}
              className={`flex flex-col items-start gap-0.5 py-3 px-4 cursor-pointer ${!n.read ? "bg-blue-50" : ""}`}
              onSelect={() => handleClick(n)}
              title={destination ? "Ouvrir" : undefined}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <p className={`text-sm ${!n.read ? "font-semibold text-slate-800" : "text-slate-600"}`}>{n.title}</p>
                <span className="flex items-center gap-1 shrink-0">
                  {!n.read && <span className="h-2 w-2 rounded-full bg-blue-500" />}
                  {destination && <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden />}
                </span>
              </div>
              {n.message && <p className="text-xs text-slate-500 leading-snug">{n.message}</p>}
              <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(n.createdAt)}</p>
            </DropdownMenuItem>
            )
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
