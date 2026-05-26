"use client"

import { useEffect, useState, useTransition } from "react"
import { Bell, CheckCheck } from "lucide-react"
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

interface Notification {
  id: string
  title: string
  message: string
  read: boolean
  readAt: Date | null
  createdAt: Date
  type: string
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen]                   = useState(false)
  const [, startTransition]               = useTransition()

  const unread = notifications.filter((n) => !n.read).length

  const load = async () => {
    const data = await getNotifications()
    setNotifications(data as unknown as Notification[])
  }

  useEffect(() => { load() }, [])

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
        <Button variant="ghost" size="icon" className="relative h-8 w-8">
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
          notifications.slice(0, 8).map((n) => (
            <DropdownMenuItem
              key={n.id}
              className={`flex flex-col items-start gap-0.5 py-3 px-4 cursor-pointer ${!n.read ? "bg-blue-50" : ""}`}
              onClick={() => !n.read && handleRead(n.id)}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <p className={`text-sm ${!n.read ? "font-semibold text-slate-800" : "text-slate-600"}`}>{n.title}</p>
                {!n.read && <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0" />}
              </div>
              {n.message && <p className="text-xs text-slate-500 leading-snug">{n.message}</p>}
              <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(n.createdAt)}</p>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
