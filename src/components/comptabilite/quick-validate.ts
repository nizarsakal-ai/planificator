// Validation directe depuis la liste des factures fournisseurs (29/10/2026, demande Nizar : « quand je clique sur valider elle doit être
// validée sans accéder au contenu »). Contrôleur PUR (sans React ni Next) : un seul appel en vol par bouton (anti double clic), succès ⇒
// rafraîchissement de la liste sur place (jamais de navigation), échec ⇒ message explicite. La décision métier reste entièrement côté
// serveur (validateSupplierInvoiceAction : accès, imputation, transaction, anti-doublons) ; rien n'est décidé ni choisi ici.

export type QuickValidateResult = { ok: true } | { ok: false; error: string }

export interface QuickValidateDeps {
  /** Appel de l'action serveur existante (aucune autre logique). */
  validate: () => Promise<QuickValidateResult>
  /** Actualise les données de la page courante (router.refresh), sans changer d'URL. */
  refresh: () => void
  onBusyChange: (busy: boolean) => void
  onSuccess: () => void
  onError: (message: string) => void
}

export const QUICK_VALIDATE_SERVER_ERROR = "Erreur serveur : facture non validée."

export function createQuickValidator(deps: QuickValidateDeps) {
  let inFlight = false
  return {
    get busy() { return inFlight },
    /** « ignored » si un appel est déjà en vol (double clic) ; sinon attend la fin et renvoie « succeeded » ou « failed ». */
    async trigger(): Promise<"ignored" | "succeeded" | "failed"> {
      if (inFlight) return "ignored"
      inFlight = true
      deps.onBusyChange(true)
      try {
        const r = await deps.validate()
        if (r.ok) { deps.onSuccess(); deps.refresh(); return "succeeded" }
        deps.onError(r.error || QUICK_VALIDATE_SERVER_ERROR)
        return "failed"
      } catch {
        deps.onError(QUICK_VALIDATE_SERVER_ERROR)
        return "failed"
      } finally {
        inFlight = false
        deps.onBusyChange(false)
      }
    },
  }
}
