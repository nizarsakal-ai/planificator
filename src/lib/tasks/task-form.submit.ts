/**
 * Module Tâches V1 — Logique de soumission du formulaire, isolée et testable.
 *
 * Aucun import React / sonner / server action : tout est injecté. Permet de prouver,
 * avec une action simulée, le comportement réel de la soumission (assemblage du
 * FormData, succès → toast + reset + fermeture, erreur → toast sans reset ni fermeture).
 */

import type { TaskStatus, TaskPriority } from "@/lib/tasks/task.schema"

/** Valeurs produites par le formulaire client (champs optionnels éventuellement vides). */
export interface TaskFormValues {
  title: string
  description?: string
  status: TaskStatus
  priority: TaskPriority
  dueDate?: string
  assigneeId?: string
  worksiteId?: string
}

/** Résultat renvoyé par la server action `createTask`. */
export type CreateTaskActionResult = { success: true } | { error: string } | void

/** Dépendances injectées : action, notifications, reset et fermeture (onSuccess). */
export interface SubmitTaskFormDeps {
  createTask: (formData: FormData) => Promise<CreateTaskActionResult>
  notifySuccess: (message: string) => void
  notifyError: (message: string) => void
  reset: () => void
  onSuccess: () => void
}

export const TASK_CREATED_MESSAGE = "Tâche créée avec succès !"

/**
 * Construit le FormData envoyé au serveur.
 * Les champs facultatifs ne sont ajoutés que lorsqu'ils ont une valeur non vide,
 * afin de laisser le serveur appliquer ses propres règles d'absence.
 */
export function buildTaskFormData(values: TaskFormValues): FormData {
  const formData = new FormData()
  formData.append("title", values.title)
  if (values.description) formData.append("description", values.description)
  formData.append("status", values.status)
  formData.append("priority", values.priority)
  if (values.dueDate) formData.append("dueDate", values.dueDate)
  if (values.assigneeId) formData.append("assigneeId", values.assigneeId)
  if (values.worksiteId) formData.append("worksiteId", values.worksiteId)
  return formData
}

/**
 * Soumet le formulaire via l'action injectée puis applique les effets de bord :
 * - erreur → notifyError, sans reset ni fermeture ;
 * - succès → notifySuccess, reset du formulaire puis fermeture (onSuccess).
 */
export async function submitTaskForm(
  values: TaskFormValues,
  deps: SubmitTaskFormDeps
): Promise<void> {
  const result = await deps.createTask(buildTaskFormData(values))

  if (result && "error" in result) {
    deps.notifyError(result.error)
    return
  }

  deps.notifySuccess(TASK_CREATED_MESSAGE)
  deps.reset()
  deps.onSuccess()
}
