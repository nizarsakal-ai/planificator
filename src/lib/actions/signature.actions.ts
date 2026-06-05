"use server"

import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { v2 as cloudinary } from "cloudinary"

export async function saveSignature(assignmentId: string, signatureDataUrl: string) {
  const session = await auth()
  if (!session?.user || session.user.role !== "TEAM_LEADER") {
    return { error: "Non autorisé" }
  }

  const employee = await prisma.employee.findFirst({
    where: { userId: session.user.id!, companyId: session.user.companyId! },
    select: { id: true },
  })
  if (!employee) return { error: "Employé introuvable" }

  // Vérifier que l'assignment appartient à l'équipe du chef
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      team: { leaderId: employee.id, companyId: session.user.companyId! },
    },
    select: { id: true, worksiteId: true },
  })
  if (!assignment) return { error: "Affectation introuvable" }

  // Upload la signature (base64 PNG) vers Cloudinary
  const uploadResult = await cloudinary.uploader.upload(signatureDataUrl, {
    folder: `planificator/signatures`,
    resource_type: "image",
    access_mode: "public",
  })

  await prisma.signature.upsert({
    where: { assignmentId },
    create: {
      assignmentId,
      signedById: employee.id,
      signatureUrl: uploadResult.secure_url,
    },
    update: {
      signedById: employee.id,
      signatureUrl: uploadResult.secure_url,
      signedAt: new Date(),
    },
  })

  revalidatePath("/planning/equipe")
  revalidatePath(`/chantiers/${assignment.worksiteId}`)
  return { success: true }
}
