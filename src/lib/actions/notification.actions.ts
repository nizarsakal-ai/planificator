"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"

export async function getNotifications() {
  const session = await auth()
  if (!session?.user) return []

  return prisma.notification.findMany({
    where:   { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take:    20,
  })
}

export async function markAllAsRead() {
  const session = await auth()
  if (!session?.user) return

  await prisma.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data:  { read: true, readAt: new Date() },
  })

  revalidatePath("/")
}

export async function markAsRead(notificationId: string) {
  const session = await auth()
  if (!session?.user) return

  // T2bis — seule une notification de l'utilisateur courant peut être marquée lue.
  await prisma.notification.updateMany({
    where: { id: notificationId, userId: session.user.id },
    data:  { read: true, readAt: new Date() },
  })
}
