/**
 * Véhicules V3 — configuration explicite du SDK Cloudinary pour les adaptateurs véhicule.
 *
 * Le SDK ne lit `CLOUDINARY_URL` qu'au premier appel de `cloudinary.config()` et ne lit jamais
 * le triplet `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` de lui-même.
 * Un adaptateur qui ne configure pas le SDK dépend donc d'une initialisation faite par un autre
 * module du même processus (ex. `expense.actions`), ce qui n'est pas garanti dans un bundle Next.js
 * par route. Ce helper rend chaque adaptateur autonome et cohérent avec l'existant :
 *   1. triplet complet → `cloudinary.config({...})` explicite (comportement historique d'import-storage) ;
 *   2. sinon `CLOUDINARY_URL` → relecture forcée de l'environnement par le SDK ;
 *   3. sinon → erreur de domaine 503, aucun octet envoyé.
 * Aucune valeur secrète n'est journalisée ni renvoyée.
 */
import { v2 as cloudinary } from "cloudinary"
import { MileageDomainError } from "./mileage-domain"

export type CloudinaryConfigSource = "triplet" | "url" | "missing"

const TRIPLET = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const
const URL_SHAPE = /^cloudinary:\/\/[^:@/\s]+:[^@/\s]+@[^/@?\s]+(?:[/?].*)?$/i

const present = (value: string | undefined) => typeof value === "string" && value.trim().length > 0

export function resolveCloudinaryConfigSource(env: NodeJS.ProcessEnv = process.env): CloudinaryConfigSource {
  if (TRIPLET.every(name => present(env[name]))) return "triplet"
  if (present(env.CLOUDINARY_URL) && URL_SHAPE.test(env.CLOUDINARY_URL!.trim())) return "url"
  return "missing"
}

/**
 * Configure le SDK depuis l'environnement et vérifie que cloud_name/api_key/api_secret sont présents.
 * @param code code d'erreur de domaine renvoyé si la configuration est absente ou incomplète (HTTP 503).
 */
export function ensureCloudinaryConfigured(code: string, env: NodeJS.ProcessEnv = process.env): CloudinaryConfigSource {
  const source = resolveCloudinaryConfigSource(env)
  if (source === "triplet") {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME!.trim(),
      api_key: env.CLOUDINARY_API_KEY!.trim(),
      api_secret: env.CLOUDINARY_API_SECRET!.trim(),
      secure: true,
    })
  } else if (source === "url") {
    // `config(true)` réinitialise l'état global et relit CLOUDINARY_URL (lecture env unique sinon).
    cloudinary.config(true)
    cloudinary.config({ secure: true })
  } else {
    throw new MileageDomainError(code, 503)
  }
  const current = cloudinary.config()
  if (!present(current.cloud_name) || !present(current.api_key) || !present(current.api_secret)) {
    throw new MileageDomainError(code, 503)
  }
  return source
}
