import { NextResponse } from "next/server"

/**
 * Auth HTTP Bearer pour crons / APIs machine — fail-closed.
 *
 * - `CRON_SECRET` absent, vide, seuls espaces, ou exactement `undefined` (après trim) → 401
 * - `Authorization` absent ou ≠ `Bearer ${secret}` → 401
 * - La valeur littérale `Authorization: Bearer undefined` n’est jamais acceptée
 *   (y compris si `CRON_SECRET` vaut la chaîne `"undefined"`).
 *
 * @returns `NextResponse` 401 si refus ; `null` si autorisé.
 */
export function assertCronBearerAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret || secret === "undefined") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return null
}
