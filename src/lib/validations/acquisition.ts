import { z } from "zod"

// ─── Assistant Consultations — validation des entrées d'acquisition ──────────
// Fondation : aucune donnée sensible (token OAuth, mot de passe, cookie,
// header Authorization, corps complet d'email) ne doit transiter par ces
// schémas ni être stockée dans rawMetadata.

/** Métadonnées d'une pièce jointe détectée (aucun téléchargement en V1). */
export const acquisitionAttachmentMetadataSchema = z.object({
  externalAttachmentId: z.string().min(1).max(255).optional(),
  /** Identifiant de partie MIME (ex : "2" ou "1.2") si le connecteur le fournit. */
  partId: z.string().min(1).max(64).optional(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z
    .number()
    .int("La taille doit être un entier")
    .min(0, "La taille d'une pièce jointe ne peut pas être négative"),
})

/**
 * rawMetadata : uniquement des métadonnées utiles et non sensibles
 * (threadId, labels, snippet court…). Taille contrôlée.
 */
const rawMetadataSchema = z
  .record(z.unknown())
  .refine((obj) => JSON.stringify(obj).length <= 10_000, {
    message: "rawMetadata trop volumineux (max 10 Ko)",
  })
  .refine(
    (obj) => {
      const forbidden = [
        "accesstoken",
        "refreshtoken",
        "authorization",
        "password",
        "cookie",
        "secret",
      ]
      return Object.keys(obj).every(
        (k) => !forbidden.some((f) => k.toLowerCase().includes(f))
      )
    },
    { message: "rawMetadata ne doit contenir aucun secret (token, mot de passe, cookie…)" }
  )

/** Entrée du service d'enregistrement d'un message entrant. */
export const registerIncomingMessageSchema = z.object({
  companyId: z.string().min(1, "companyId requis"),
  source: z.enum(["GMAIL"]),
  externalMessageId: z.string().min(1, "Identifiant externe requis").max(255),
  /**
   * Adresse réelle de l'expéditeur telle que fournie par le connecteur
   * (header From). La normalisation et l'extraction stricte du domaine
   * sont faites par le service — jamais depuis le corps ou l'objet.
   */
  senderEmail: z.string().min(3).max(320),
  subject: z.string().max(500).default(""),
  receivedAt: z.coerce.date(),
  rawMetadata: rawMetadataSchema.optional(),
  attachments: z.array(acquisitionAttachmentMetadataSchema).max(50).default([]),
})

export type AcquisitionAttachmentMetadata = z.infer<typeof acquisitionAttachmentMetadataSchema>
export type RegisterIncomingMessageInput = z.input<typeof registerIncomingMessageSchema>
