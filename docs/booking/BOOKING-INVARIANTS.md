# Booking Gmail — Invariants métier

| Champ | Valeur |
|-------|--------|
| **Identifiant** | C-BOOK-001 — invariants |
| **Périmètre** | Traitement des emails Booking.com vers logements |
| **Hors périmètre** | Acquisition, Platform, UI, détails d’implémentation |

Ces règles sont **normatives**. Toute implémentation DOIT les respecter.

---

## Cycle de vie d’un message

1. Un message Gmail **n’est jamais** considéré comme réussi (`SUCCEEDED`) **avant** que le résultat métier (logement ou pending) soit **persisté** de façon cohérente avec ce succès.
2. Une erreur survenue **avant** cette persistance **ne consomme pas définitivement** le message : un nouvel essai doit rester possible selon la politique de retry.
3. Un message déjà **réussi** n’est **pas** retraité pour créer un second résultat.
4. Un message définitivement ignoré (règle métier permanente ou plafond d’essais) n’est **pas** retraité automatiquement.

## Retry et concurrence

5. Un retry **ne crée jamais** de doublon de logement ni de pending pour le même message Gmail d’un même tenant.
6. Deux exécutions concurrentes sur le même message produisent **au plus un** résultat métier effectif.
7. Un traitement abandonné en cours (sans succès) peut être **repris** après un délai raisonnable, sans violer les règles 5 et 6.

## Idempotence métier

8. Pour un couple `(entreprise, message Gmail)`, il existe **au plus un** `PendingAccommodation` actif de référence.
9. Pour un couple `(entreprise, message Gmail)`, il existe **au plus une** `Accommodation` issue de ce message (identité technique Gmail distincte de la référence Booking.com métier).
10. La référence Booking.com métier **n’est pas** un substitut de l’identifiant technique Gmail.

## Données et sécurité opérationnelle

11. **Aucune** donnée existante (pending, logement, historique de suivi) n’est **supprimée automatiquement** pour résoudre des doublons ou des conflits.
12. Les décisions de non-retraitement permanent (cutoff, parsing vide, etc.) restent **traçables** au niveau du suivi du message.

## Isolation

13. Le suivi des messages Booking **n’est pas** le suivi des messages Acquisition : les règles ci-dessus s’appliquent au canal logements Booking uniquement.
