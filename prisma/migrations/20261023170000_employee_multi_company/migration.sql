-- Keep one login identity; scope employee membership and role to the company.
ALTER TABLE "employees" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'EMPLOYEE';
UPDATE "employees" e SET "role" = u."role" FROM "users" u WHERE e."userId" = u."id";
DROP INDEX "employees_userId_key";
CREATE UNIQUE INDEX "employees_userId_companyId_key" ON "employees"("userId", "companyId");
