# Domaine — Finance

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour l'inventaire minimal ; **À AUDITER** pour les règles. **Aucun test dans `tests/factures/` ni `tests/notes-de-frais/` (dossiers inexistants).**

| Élément | Constat |
|---------|---------|
| Modèles | `Article`, `Quote`, `QuoteLine`, `Invoice`, `InvoiceLine`, `DocumentCounter` (numérotation), `ExpenseReport`, `CompanySettings` ; enums `QuoteStatus`, `InvoiceStatus`, `ExpenseCategory`, `ExpenseStatus` |
| Pages | `/factures`, `/articles`, `/notes-de-frais`, `/mes-notes-de-frais`, `/rapports` |
| Code | `src/lib/billing/`, `src/lib/actions/invoice.actions.ts`, `article.actions.ts`, `expense.actions.ts` |
| PDF | `/api/pdf/{signature,paie,presence,chantier,mensuel,rapport}` |

## À AUDITER (priorité haute : données financières sans tests)

Numérotation atomique des documents (`DocumentCounter`, concurrence), immutabilité d'une facture émise, arrondis/TVA, isolation tenant des PDF, autorisations sur les notes de frais.
