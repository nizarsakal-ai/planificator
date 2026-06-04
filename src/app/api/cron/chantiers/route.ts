import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

// Protégé par le secret Vercel Cron (Authorization: Bearer <CRON_SECRET>)
// Déclenché automatiquement via vercel.json — ne jamais exposer publiquement

export async function GET(req: Request) {
  // Vérification du secret Vercel Cron
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now   = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  const stats = { started: 0, completed: 0, archived: 0 }

  // ── 0. DELAYED → IN_PROGRESS : chantiers décalés dont la date de reprise est arrivée ──
  const delayedToStart = await prisma.worksite.findMany({
    where: {
      status:       "DELAYED",
      delayedUntil: { lte: today },
    },
    select: { id: true },
  })

  if (delayedToStart.length > 0) {
    await prisma.worksite.updateMany({
      where: { id: { in: delayedToStart.map((w) => w.id) } },
      data:  { status: "IN_PROGRESS", delayedUntil: null },
    })
    stats.started += delayedToStart.length
  }

  // ── 1. PLANNED → IN_PROGRESS : chantiers dont la date de début est arrivée ──
  const toStart = await prisma.worksite.findMany({
    where: {
      status:    "PLANNED",
      startDate: { lte: today },
    },
    select: { id: true, companyId: true, name: true },
  })

  if (toStart.length > 0) {
    await prisma.worksite.updateMany({
      where: { id: { in: toStart.map((w) => w.id) } },
      data:  { status: "IN_PROGRESS" },
    })
    stats.started = toStart.length
  }

  // ── 2. IN_PROGRESS / EXTENDED → COMPLETED : chantiers dont la date de fin est dépassée ──
  const toComplete = await prisma.worksite.findMany({
    where: {
      status:  { in: ["IN_PROGRESS", "EXTENDED"] },
      endDate: { lt: today },
    },
    select: { id: true, companyId: true, name: true },
  })

  if (toComplete.length > 0) {
    await prisma.worksite.updateMany({
      where: { id: { in: toComplete.map((w) => w.id) } },
      data:  { status: "COMPLETED", completedAt: now },
    })
    stats.completed = toComplete.length
  }

  // ── 3. COMPLETED → ARCHIVED : chantiers terminés depuis plus de 48h ──────────
  // Récupère le délai d'archivage par entreprise (CompanySettings.archiveDelayHours, défaut 48h)
  const settings = await prisma.companySettings.findMany({
    select: { companyId: true, archiveDelayHours: true },
  })
  const delayByCompany = new Map(settings.map((s) => [s.companyId, s.archiveDelayHours]))

  // Récupérer tous les chantiers COMPLETED avec completedAt renseigné
  const completedWorksites = await prisma.worksite.findMany({
    where: {
      status:      "COMPLETED",
      completedAt: { not: null },
    },
    select: { id: true, companyId: true, completedAt: true },
  })

  const toArchive = completedWorksites.filter((w) => {
    const delay = delayByCompany.get(w.companyId) ?? 48
    const archiveAfter = new Date(w.completedAt!)
    archiveAfter.setHours(archiveAfter.getHours() + delay)
    return now >= archiveAfter
  })

  if (toArchive.length > 0) {
    await prisma.worksite.updateMany({
      where: { id: { in: toArchive.map((w) => w.id) } },
      data:  { status: "ARCHIVED", archivedAt: now },
    })
    stats.archived = toArchive.length
  }

  console.log(`[CRON chantiers] ${now.toISOString()} — démarrés: ${stats.started}, terminés: ${stats.completed}, archivés: ${stats.archived}`)

  return NextResponse.json({ ok: true, ...stats })
}
