-- Lot B (revue de code d'intégration, P1-2) : une facture émise est figée (déclencheurs Lot B), donc
-- ON DELETE SET NULL vers le devis ou l'article provoquerait un UPDATE refusé (erreur brute) lors d'une
-- suppression physique. On refuse explicitement la suppression d'un devis/article référencé.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_quoteId_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_articleId_fkey";
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
