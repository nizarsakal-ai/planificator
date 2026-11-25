/**
 * Lot G Planificator V2 : Document Studio — règles PURES et empreintes.
 *
 * Lot G2 (22/11/2026) : les règles de contenu (champs, mise en forme, valeurs, rendu) vivent dans `./studio.format`, sans
 * dépendance serveur, pour que l'éditeur visuel calcule son aperçu avec le même code ; ce module les réexporte toutes et
 * garde les empreintes (`node:crypto`). Les imports existants de `studio.core` restent valables.
 * Portage sur ef36578f (19/11/2026) : forme canonique et empreinte locales au lot G (`./canonical`, sémantique v6 inchangée),
 * sans dépendance au lot D.
 */
import { canonicalJson, sha256Hex } from "@/lib/document-studio/canonical"
import type { DocumentSnapshot, VersionContent } from "@/lib/document-studio/studio.format"

export * from "@/lib/document-studio/studio.format"

/** Empreinte du contenu publié (ordre des champs conservé : il fixe l'ordre du formulaire). */
export const versionSha256 = (c: VersionContent) => sha256Hex(canonicalJson({ title: c.title, body: c.body, fields: c.fields.map((f) => ({ ...f })), requiresApproval: c.requiresApproval }))
export const documentSha256 = (s: DocumentSnapshot) => sha256Hex(canonicalJson(s))
