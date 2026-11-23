// Lot D : pastilles des réserves (classes de couleur déjà présentes dans l'application, mêmes tons que les lots A et B).
export const RESERVE_STATUS_CLASS: Record<string, string> = { OPEN: "bg-amber-50 text-amber-700", LIFTED: "bg-green-50 text-green-700", CANCELLED: "bg-slate-100 text-slate-700" }
export const SEVERITY_CLASS: Record<string, string> = { MINOR: "bg-slate-100 text-slate-700", MAJOR: "bg-amber-50 text-amber-700", BLOCKING: "bg-red-50 text-red-600" }
export const DECISION_CLASS: Record<string, string> = { WITHOUT_RESERVES: "bg-green-50 text-green-700", WITH_RESERVES: "bg-amber-50 text-amber-700", REFUSED: "bg-red-50 text-red-600" }
