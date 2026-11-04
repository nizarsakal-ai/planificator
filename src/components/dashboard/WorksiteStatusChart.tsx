"use client"

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts"

interface Props {
  data: { name: string; value: number; color: string }[]
}

// Répartition des chantiers (V2) : anneau avec le total au centre, légende avec effectifs et parts.
export function WorksiteStatusChart({ data }: Props) {
  const filtered = data.filter((d) => d.value > 0)
  if (filtered.length === 0) return (
    <div className="h-[180px] flex items-center justify-center text-sm text-slate-300">
      Aucun chantier
    </div>
  )

  const total = data.reduce((s, d) => s + d.value, 0)

  return (
    <div className="flex items-center gap-5">
      <div className="relative h-[150px] w-[150px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={filtered}
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={68}
              paddingAngle={3}
              cornerRadius={8}
              stroke="none"
              dataKey="value"
            >
              {filtered.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #dbe5fb" }}
              formatter={(v, name) => [`${v}`, String(name)]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-bold leading-none tracking-tight text-slate-900">{total}</span>
          <span className="mt-1 text-[11px] text-slate-500">chantier{total > 1 ? "s" : ""}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-2">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2 text-[12.5px] text-slate-700">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            {d.name}
            <span className="ml-auto font-semibold tabular-nums text-slate-900">{d.value}</span>
            <span className="w-9 text-right text-[11px] tabular-nums text-slate-500">
              {total > 0 ? Math.round((d.value / total) * 100) : 0} %
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
