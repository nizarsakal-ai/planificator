export interface NormalizedSender {
  email: string
  domain: string
}

/**
 * Normalise une adresse expéditeur :
 * - accepte la forme « Nom Affiché <adresse@domaine> » (header From) en ne
 *   retenant QUE l'adresse entre chevrons — jamais le nom d'affichage ;
 * - trim + minuscules ;
 * - validation stricte de la forme adresse@domaine ;
 * - extraction du domaine réel (partie après le dernier « @ »).
 *
 * Retourne null si l'adresse est invalide.
 */
export function normalizeSenderAddress(raw: string): NormalizedSender | null {
  if (typeof raw !== "string") return null
  let candidate = raw.trim()

  // Forme « Display Name <addr@domain> » : extraire le contenu des chevrons.
  const angleMatch = candidate.match(/<([^<>]*)>\s*$/)
  if (angleMatch) candidate = angleMatch[1].trim()

  candidate = candidate.toLowerCase()

  // Validation stricte : une seule « partie locale » non vide, un domaine
  // composé d'au moins deux labels alphanumériques (a-z0-9-), sans espaces.
  const emailRegex =
    /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/
  const match = candidate.match(emailRegex)
  if (!match) return null

  return { email: candidate, domain: match[1] }
}
