"use server"

/**
 * Module Tâches V1 — Server Actions.
 * Adaptateur mince : branche Prisma / auth / revalidation réels sur le cœur testable.
 */

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { auth } from "@/auth"
import { createTaskCore } from "@/lib/actions/task-create.core"
import { buildPrismaTaskDeps, type TaskPrismaClient } from "@/lib/actions/task-create.prisma"
import { taskFormDataToRaw } from "@/lib/tasks/task.schema"

export async function createTask(
  formData: FormData
): Promise<{ success: true } | { error: string }> {
  const raw = taskFormDataToRaw(formData)
  const deps = buildPrismaTaskDeps(
    prisma as unknown as TaskPrismaClient,
    auth,
    () => revalidatePath("/dashboard")
  )
  const result = await createTaskCore(raw, deps)
  if (!result.ok) return { error: result.message }
  return { success: true }
}
