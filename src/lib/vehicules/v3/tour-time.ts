/** Heure civile de l'entreprise, indépendante du fuseau de l'appareil. */
function civilParts(date: Date, timeZone: string) {
    const values: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date))
        if (part.type !== "literal")
            values[part.type] = Number(part.value);
    return [values.year, values.month, values.day, values.hour, values.minute, values.second];
}
export function companyCivilTimeToIso(value: string, timeZone: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!m)
        throw new Error("INVALID_CIVIL_TIME");
    const parts = m.slice(1).map(Number);
    parts[5] = parts[5] || 0;
    const wall = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    const check = new Date(wall);
    if ([check.getUTCFullYear(), check.getUTCMonth() + 1, check.getUTCDate(), check.getUTCHours(), check.getUTCMinutes(), check.getUTCSeconds()].some((v, i) => v !== parts[i]))
        throw new Error("INVALID_CIVIL_TIME");
    const offsets = new Set<number>();
    // Sample both sides of an offset transition, then validate exact civil fields.
    for (let delta = -48; delta <= 48; delta += 6) {
        const instant = wall + delta * 3600000;
        const p = civilParts(new Date(instant), timeZone);
        offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - instant);
    }
    const candidates = [...offsets].map(offset => new Date(wall - offset)).filter(date => civilParts(date, timeZone).every((v, i) => v === parts[i]));
    if (candidates.length === 0)
        throw new Error("NONEXISTENT_CIVIL_TIME");
    if (candidates.length !== 1)
        throw new Error("AMBIGUOUS_CIVIL_TIME");
    return candidates[0].toISOString();
}
export function selectApprovedTourImport(rows: unknown, id: string, revision: number): {
    id: string;
    revision: number;
    candidates: {
        label: string;
        address: string;
    }[];
} {
    if (!Array.isArray(rows))
        throw new Error("IMPORT_UNAVAILABLE");
    const row = rows.find((v: unknown) => typeof v === "object" && v !== null && "id" in v && v.id === id);
    if (!row || row.status !== "APPROVED" || row.revision !== revision || !Array.isArray(row.candidates) || !row.candidates.length || row.candidates.some((c: unknown) => typeof c !== "object" || !c || !("confirmed" in c) || c.confirmed !== true || !("address" in c) || typeof c.address !== "string" || !("label" in c) || typeof c.label !== "string"))
        throw new Error("IMPORT_UNAVAILABLE");
    return row;
}
export const civilTimeToIso = companyCivilTimeToIso;
