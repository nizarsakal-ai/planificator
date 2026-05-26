"use client"

import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts"

interface Props {
  data: { name: string; value: number; color: string }[]
}

export function WorksiteStatusChart({ data }: Props) {
  const filtered = data.filter((d) => d.value > 0)
  if (filtered.length === 0) return (
    <div className="h-[180px] flex items-center justify-center text-sm text-slate-300">
      Aucun chantier
    </div>
  )

  return (
    <ResponsiveContainer width="100%" height={180}>
      <PieChart>
        <Pie
          data={filtered}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={75}
          paddingAngle={3}
          dataKey="value"
        >
          {filtered.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
          formatter={(v, name) => [`${v}`, String(name)]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}
