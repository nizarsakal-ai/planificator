# Booking E2E proof tests (PLAN-BOOKING-E2E-PROOF-001)

Tests automatisés de preuve pour le parcours Pending → confirm / dismiss et extraction déterministe.

## Fixture

- Fichier : `tests/booking/fixtures/booking-e2e-fixture-001.html`
- Marqueur : `BOOKING-E2E-FIXTURE-001`
- Nature : **fixture anonymisée et représentative**, pas un export de production
- Aucune donnée personnelle réelle, aucune adresse réelle, aucun id Gmail / réservation réel, aucun secret

## Commandes

```bash
npm run test:booking:unit
# ou ciblé :
node --import tsx --test tests/booking/booking-e2e-proof-001.test.ts
```

## Hors périmètre de ces tests

- Aucun appel Gmail
- Aucun appel Anthropic (extraction via `anthropic = null` / regex)
- Aucune base PostgreSQL réelle (fakes transactionnels en mémoire)
- Aucune activation de feature flag
