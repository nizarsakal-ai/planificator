#!/bin/sh
# Lot B — essais de concurrence à deux sessions (base jetable déjà migrée). Usage : PSQL="psql -U postgres -d t" sh lot-b-concurrency.sh
set -eu
P="${PSQL:-psql -U postgres -d t} -At -q -v ON_ERROR_STOP=1"
fail=0
setup() {
  $P -c "INSERT INTO invoices(id,\"companyId\",\"worksiteId\",\"clientId\",number,\"createdById\",\"updatedAt\",status) VALUES ('$1','coA','wA','clA','FAC-$1','u',now(),'DRAFT'); INSERT INTO invoice_lines(id,\"invoiceId\",designation,quantity,\"unitPrice\",\"vatRate\",\"lineHT\") VALUES ('l$1','$1','AVANT',1,1,20,1);" >/dev/null
}
# C1 : modification de ligne d'abord (transaction ouverte 3 s) ; émission concurrente => attend, puis émet sur la version finale.
setup c1
( $P -c "BEGIN; UPDATE invoice_lines SET designation='APRES' WHERE id='lc1'; SELECT pg_sleep(3); COMMIT;" >/dev/null ) &
sleep 1
t0=$(date +%s); $P -c "UPDATE invoices SET status='SENT', \"sentAt\"=now() WHERE id='c1' AND status='DRAFT';" >/dev/null; t1=$(date +%s); wait
r=$($P -c "SELECT i.status||'|'||l.designation FROM invoices i JOIN invoice_lines l ON l.\"invoiceId\"=i.id WHERE i.id='c1';")
if [ "$r" = "SENT|APRES" ] && [ $((t1-t0)) -ge 1 ]; then echo "PASS C1 émission attend la modification de ligne en cours ($((t1-t0)) s) puis émet : $r"; else echo "FAIL C1 $r attente=$((t1-t0))"; fail=1; fi
if $P -c "UPDATE invoice_lines SET designation='TARD' WHERE id='lc1';" >/dev/null 2>&1; then echo "FAIL C1b ligne modifiée après émission"; fail=1; else echo "PASS C1b ligne non modifiable après émission"; fi
# C2 : émission d'abord (transaction ouverte 3 s) ; modification de ligne concurrente => attend, puis refusée.
setup c2
( $P -c "BEGIN; UPDATE invoices SET status='SENT', \"sentAt\"=now() WHERE id='c2'; SELECT pg_sleep(3); COMMIT;" >/dev/null ) &
sleep 1
if $P -c "UPDATE invoice_lines SET designation='APRES' WHERE id='lc2';" >/dev/null 2>/tmp/c2.err; then r2=ok; else r2=refus; fi; wait
d=$($P -c "SELECT designation FROM invoice_lines WHERE id='lc2';")
if [ "$r2" = refus ] && [ "$d" = AVANT ] && grep -q INVOICE_IMMUTABLE /tmp/c2.err; then echo "PASS C2 modification concurrente d'une facture en cours d'émission refusée (ligne=$d)"; else echo "FAIL C2 r=$r2 ligne=$d"; fail=1; fi
# C3 : deux avoirs concurrents sur la même facture => un seul réussit.
$P -c "INSERT INTO invoices(id,\"companyId\",\"worksiteId\",\"clientId\",number,\"createdById\",\"updatedAt\",status,\"totalHT\",\"totalVAT\",\"totalTTC\") VALUES ('c3','coA','wA','clA','FAC-c3','u',now(),'DRAFT',100,20,120); UPDATE invoices SET status='SENT', \"sentAt\"=now() WHERE id='c3';" >/dev/null
note() { $P -c "BEGIN; UPDATE invoices SET status='CANCELLED' WHERE id='c3' AND status='SENT'; INSERT INTO invoices(id,\"companyId\",\"worksiteId\",\"clientId\",number,\"createdById\",\"updatedAt\",status,kind,\"creditedInvoiceId\",\"totalHT\",\"totalVAT\",\"totalTTC\") VALUES ('$1','coA','wA','clA','$1','u',now(),'DRAFT','CREDIT_NOTE','c3',100,20,120); SELECT pg_sleep(1); UPDATE invoices SET status='SENT', \"sentAt\"=now() WHERE id='$1'; COMMIT;" >/dev/null 2>&1 && echo ok || echo ko; }
note avA > /tmp/c3a & note avB > /tmp/c3b; wait
n=$($P -c "SELECT count(*) FROM invoices WHERE \"creditedInvoiceId\"='c3' AND kind='CREDIT_NOTE' AND status='SENT';")
if [ "$n" = 1 ]; then echo "PASS C3 deux avoirs concurrents : un seul émis"; else echo "FAIL C3 avoirs émis=$n"; fail=1; fi
[ $fail = 0 ] && echo "RESULTAT CONCURRENCE: OK" || { echo "RESULTAT CONCURRENCE: ECHEC"; exit 1; }
