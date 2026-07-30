/**
 * PLAN-ACQ-012-LOT-1.4-R4 — Cutover runtime Partner Registry.
 *
 * ## Ordre de déploiement non négociable
 *
 * 1. Fusionner le LOT-1.1 (schéma registre)
 * 2. Appliquer `prisma migrate deploy` sur la **cible explicitement sélectionnée**
 *    (vérifier `DATABASE_URL` sans jamais l’imprimer)
 * 3. Publier le LOT-1.2
 * 4. Exécuter le bootstrap :
 *    `npm run db:bootstrap:acquisition-partners`
 * 5. Inspecter et valider son rapport :
 *    - aucune erreur technique ;
 *    - aucun conflit non résolu ;
 *    - toutes les Companies attendues traitées
 * 6. Exécuter le preflight readiness (lecture seule) :
 *    `npm run db:check:acquisition-partners-readiness`
 * 7. Vérifier :
 *    - exit code **0** ;
 *    - `companiesTotal > 0` ;
 *    - `companiesReady === companiesTotal`
 * 8. Seulement ensuite promouvoir le LOT-1.4 (runtime cutover)
 * 9. Lancer un sync Gmail **contrôlé**
 * 10. Contrôler :
 *     - aucun rejet LAURALU inattendu ;
 *     - aucun échec resolver ;
 *     - compteurs cohérents
 *
 * **Ne jamais promouvoir le runtime cutover si le preflight échoue.**
 * Aucune commande ne doit viser la production sans vérification explicite
 * de la cible et de `DATABASE_URL` (valeur jamais affichée).
 *
 * ## Readiness exacte (transition)
 *
 * Pour chaque Company existante (critère **cutover historique**, remplacé Lot I) :
 * - ~~partenaire `code=lauralu` + domaine `lauralu.fr`~~
 * - **Lot I durable** : ≥1 partenaire actif + ≥1 identité (domaine|email) active
 *   (`checkAcquisitionPartnerRegistryReadiness`).
 *
 * ## Caractère temporaire de la règle LAURALU
 *
 * Cette exigence concernait **uniquement** le cutover depuis l’ancien gate
 * hardcodé `lauralu.fr`. Elle **n’est pas** une obligation permanente.
 * Après Lot I, LAURALU n’est qu’un seed data optionnel parmi d’autres partenaires.
 *
 * ### Company ayant désactivé volontairement LAURALU
 *
 * Le preflight échoue volontairement. L’opérateur doit décider avant promotion :
 * - réactiver temporairement pour préserver le flux historique ; ou
 * - confirmer que cette Company ne doit plus recevoir les emails LAURALU
 *   et traiter explicitement son cas.
 * Le script **ne réactive jamais** automatiquement.
 *
 * ### Company créée après le bootstrap
 *
 * Elle doit faire l’objet d’un nouveau passage du bootstrap LOT-1.2 avant
 * le preflight.
 *
 * ## Convention zéro Company
 *
 * `companiesTotal = 0` → échec, code `NO_COMPANIES_FOUND`, exit `1`.
 * Un succès vide pourrait indiquer une mauvaise cible / `DATABASE_URL`.
 *
 * ## Exit codes preflight
 *
 * - `0` : au moins une Company et toutes prêtes
 * - `1` : aucune Company, au moins une non prête, ou erreur DB
 *
 * ## Registre vide runtime
 *
 * Sans configuration, le runtime rejette en `REJECTED` / `SENDER_NOT_ELIGIBLE`
 * (pas de fallback). L’idempotence fige ce rejet — d’où bootstrap →
 * preflight → deploy.
 *
 * ## Composition root
 *
 * `registerIncomingMessage` instancie par défaut
 * `PartnerEligibilityResolver(PartnerRegistryRepository(db))` localement.
 * Le chemin métier n’appelle que le port resolver ; les tests injectent
 * `deps.eligibilityResolver`. Pas de conteneur DI.
 */
