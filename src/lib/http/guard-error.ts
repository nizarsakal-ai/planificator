/**
 * Garde HTTP partagée — erreur typée minimale (code stable + statut HTTP), sans dépendance métier.
 *
 * Les modules qui réutilisent les helpers de `src/lib/http` peuvent soit laisser cette erreur
 * remonter, soit fournir leur propre `reject` pour conserver leur classe d'erreur historique
 * (ex. `MileageDomainError` côté Véhicules). Le message ne contient jamais de donnée de requête.
 */
export class HttpGuardError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = "HttpGuardError"
  }
}

/** Lève l'erreur de refus choisie par l'appelant ; ne retourne jamais. */
export type RejectFn = (code: string, status: number) => never

export const rejectWithHttpGuardError: RejectFn = (code, status) => {
  throw new HttpGuardError(code, status)
}
