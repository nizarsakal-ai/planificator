"use client"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

/** Graphique du CA HT mensuel (montants en euros pour l'affichage uniquement). */
export function RevenueChart({ data }: { data: { period: string; amount: number }[] }) {
  const fmt = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v)
  return (
    <div className="h-64 w-full" role="img" aria-label="Chiffre d'affaires HT par mois">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(p: string) => p.slice(5) + "/" + p.slice(2, 4)} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmt(v)} width={80} />
          <Tooltip formatter={(v) => fmt(Number(v))} labelFormatter={(l) => `Mois ${l}`} />
          <Bar dataKey="amount" fill="#0f3460" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
