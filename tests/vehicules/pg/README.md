# Dedicated local PostgreSQL validation

These scripts refuse any URL except PostgreSQL on `127.0.0.1:55432/vehicule_test`, user `vehicule_test`, without query parameters. They only read `VEHICULE_V2_DATABASE_URL`; they never use `DATABASE_URL`. Apply the complete migration history to this dedicated disposable database beforehand. Do not use a production clone or `db push`.

```sh
export VEHICULE_V2_DATABASE_URL='postgresql://vehicule_test:vehicule_v2_local_test@127.0.0.1:55432/vehicule_test'
node --import tsx --test tests/vehicules/pg/v2.pg.test.ts
node --import tsx tests/vehicules/pg/seed-demo.ts
```

Tests create unique `v2-test-…` fixtures on every invocation. They do not delete immutable journals or alter migrations. Retire the disposable database/container to clean up.

The browser seed is repeatable and provides `vehicule-v2@example.test` / `Test-Vehicule-V2-2026`, an explicit local Super Admin company context, and two demonstration vehicles (one due soon, one due). These credentials are local test data only.

The integration test exercises actual transaction locks, concurrent idempotent writes, concurrent optimistic maintenance-plan conflict, trip corrections, historical oil records, reminders, multi-company membership authority, global Super Admin, inactive membership denial, tenant-scoped API access, validated composite SQL foreign keys, immutable journal SQL triggers and archived write denial. It fails rather than skips if its dedicated database is unavailable.
