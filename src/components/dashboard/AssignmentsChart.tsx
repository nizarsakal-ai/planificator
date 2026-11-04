"use client"

import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts"

interface Props {
  data: { day: string; count: number }[]
}

// Affectations par semaine (V2) : barres bleu foncé, valeur au-dessus, semaine en cours plus claire.
// Les textes passent par les classes slate (variables de thème) pour rester lisibles en Apparence sombre.
export function AssignmentsChart({ data }: Props) {
  const last = data.length - 1
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 20, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="assignments-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1e4f8f" />
            <stop offset="1" stopColor="#0f3460" />
          </linearGradient>
          <linearGradient id="assignments-bar-current" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9db7e6" />
            <stop offset="1" stopColor="#7f9fd6" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 4" vertical={false} className="stroke-slate-200" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fontSize: 11, className: "fill-slate-400" }} />
        <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, className: "fill-slate-400" }} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: "rgba(15,52,96,0.06)" }}
          contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #dbe5fb" }}
          formatter={(v) => [`${v} affectation${Number(v) > 1 ? "s" : ""}`, ""]}
        />
        <Bar dataKey="count" radius={[9, 9, 0, 0]} maxBarSize={54}>
          {data.map((_, i) => (
            <Cell key={i} fill={i === last && last > 0 ? "url(#assignments-bar-current)" : "url(#assignments-bar)"} />
          ))}
          <LabelList dataKey="count" position="top" className="fill-slate-900" fontSize={11.5} fontWeight={700} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
