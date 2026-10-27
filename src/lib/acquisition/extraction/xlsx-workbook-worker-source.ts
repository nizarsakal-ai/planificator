/** JavaScript autonome embarqué dans le bundle serveur, sans fichier TS à charger
 * à l'exécution. Aucun accès réseau ni évaluation de formule ; données via workerData. */
export const XLSX_WORKER_SOURCE = String.raw`
const { parentPort, workerData: o } = require("node:worker_threads")
const ExcelJS = require(o.exceljsPath)
function text(value) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean") return value ? "VRAI" : "FAUX"
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ""
    const iso = value.toISOString()
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ")
  }
  if (typeof value !== "object") return ""
  if (Array.isArray(value.richText)) return value.richText.map(r => typeof r?.text === "string" ? r.text : "").join("")
  if ("formula" in value || "sharedFormula" in value) {
    const cached = value.result
    return cached && typeof cached === "object" && !(cached instanceof Date) ? "" : text(cached)
  }
  if (typeof value.text === "string") return value.text
  if (value.text && Array.isArray(value.text.richText)) return text(value.text)
  return ""
}
function clean(value) {
  return text(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, o.maxCellChars)
}
async function extract() {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(o.bytes))
  const lines = []
  let chars = 0, truncated = false, anyValue = false
  function push(line) {
    const room = o.maxChars - chars - 1
    if (line.length > room) {
      if (room > 0) lines.push(line.slice(0, room))
      truncated = true
      return false
    }
    lines.push(line)
    chars += line.length + 1
    return true
  }
  outer: for (let si = 0; si < workbook.worksheets.length; si++) {
    if (si >= o.maxSheets) { truncated = true; break }
    const sheet = workbook.worksheets[si]
    let rowCount = 0, heading = false, textFull = false
    // eachRow parcourt uniquement les rangées existantes : un numéro de ligne
    // très élevé ne doit pas créer des centaines de milliers de rangées vides.
    sheet.eachRow(row => {
      if (textFull) return
      if (Date.now() >= o.deadlineAt) throw new Error("DEADLINE")
      if (rowCount >= o.maxRowsPerSheet) { truncated = true; return }
      const cells = []
      const values = Array.isArray(row.values) ? row.values : []
      for (let ci = 1; ci < values.length && cells.length < o.maxCellsPerRow; ci++) {
        const cell = clean(values[ci])
        if (cell) cells.push(cell)
      }
      if (!cells.length) return
      rowCount++
      anyValue = true
      if (!heading) {
        heading = true
        if (!push("--- Feuille: " + clean(sheet.name).slice(0, 64) + " ---")) { textFull = true; return }
      }
      if (!push(cells.join(" | "))) textFull = true
    })
    if (textFull) break outer
  }
  if (!anyValue) return { status: "XLSX_EMPTY", text: "", truncated: false }
  return { status: truncated ? "XLSX_TEXT_TRUNCATED" : "XLSX_TEXT_EXTRACTED", text: lines.join("\n").trim(), truncated }
}
extract().then(r => parentPort.postMessage(r), () => parentPort.postMessage({ status: "XLSX_PARSE_FAILED", text: "", truncated: false }))
`
