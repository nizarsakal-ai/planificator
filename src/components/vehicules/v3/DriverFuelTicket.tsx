"use client"

/**
 * Ticket carburant du chauffeur (mobile) : photo → lecture automatique → vérification → envoi.
 * Le ticket devient le justificatif comptable du plein et complète le plein du relevé bancaire s'il existe.
 */
import { useEffect, useState } from "react"
import { Camera, Loader2, CheckCircle2 } from "lucide-react"
import { compressImage, PhotoCompressionError } from "@/lib/worksite-photos/client/compress-image"

type Truck = { id: string; matricule: string; marque: string | null; modele: string | null }
type Proposal = {
  readable: boolean
  fuel: boolean
  refund: boolean
  amount: { value: string; sure: boolean } | null
  litres: { value: string; sure: boolean } | null
  day: { value: string; sure: boolean } | null
  station: { value: string; sure: boolean } | null
  mileage?: { value: number; sure: boolean } | null
}
type Pending = { key: string; blob: Blob; previewUrl: string }

const input = "block w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base text-black"
const ERRORS: Record<string, string> = {
  TRUCK_NOT_FOUND: "Ce camion ne vous est pas attribué.",
  TICKET_DATE_INVALID: "Date du ticket invalide (ni future, ni de plus de 2 mois).",
  INVALID_PAYLOAD: "Vérifiez le montant, les litres et la date.",
  DOCUMENT_TOO_LARGE: "Photo trop lourde : reprenez-la.",
  RECOGNITION_BUSY: "Lecture déjà en cours, réessayez dans un instant.",
  RECOGNITION_TIMEOUT: "Lecture trop longue : saisissez les montants.",
  FUTURE_EXPENSE: "Date du ticket dans le futur : vérifiez la date.",
  V3_DISABLED: "L’envoi des tickets n’est pas activé : prévenez le bureau.",
  FEATURE_DISABLED: "L’envoi des tickets n’est pas activé : prévenez le bureau.",
  FORBIDDEN: "Vous n’avez pas le droit d’envoyer ce ticket : prévenez le bureau.",
  UNAUTHENTICATED: "Reconnectez-vous puis réessayez.",
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

export function DriverFuelTicket() {
  const [trucks, setTrucks] = useState<Truck[] | null>(null)
  const [recognition, setRecognition] = useState(false)
  const [truckId, setTruckId] = useState("")
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState<"photo" | "read" | "send" | null>(null)
  const [error, setError] = useState("")
  const [readNote, setReadNote] = useState("")
  const [done, setDone] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [litres, setLitres] = useState("")
  const [day, setDay] = useState(today())
  const [station, setStation] = useState("")
  const [mileage, setMileage] = useState("")

  useEffect(() => {
    fetch("/api/me/trucks", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ trucks: Truck[]; recognitionEnabled: boolean }> })
      .then((d) => { setTrucks(d.trucks); setRecognition(d.recognitionEnabled); if (d.trucks.length === 1) setTruckId(d.trucks[0].id) })
      .catch(() => setTrucks([]))
  }, [])

  function reset() {
    if (pending) URL.revokeObjectURL(pending.previewUrl)
    setPending(null); setAmount(""); setLitres(""); setDay(today()); setStation(""); setMileage(""); setReadNote(""); setError(""); setDone(null)
  }

  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file || !truckId) return
    reset()
    setBusy("photo")
    try {
      const compressed = await compressImage(file)
      const next = { key: crypto.randomUUID(), blob: compressed.blob, previewUrl: URL.createObjectURL(compressed.blob) }
      setPending(next)
      if (recognition) await read(next)
    } catch (err) {
      setError(err instanceof PhotoCompressionError && err.code === "TOO_LARGE_AFTER_COMPRESSION" ? "Photo trop lourde même compressée : reprenez-la." : "Impossible de lire cette photo.")
    } finally {
      setBusy(null)
    }
  }

  async function read(p: Pending) {
    setBusy("read")
    try {
      const form = new FormData()
      form.append("file", p.blob, "ticket.jpg")
      form.append("payload", JSON.stringify({ truckId }))
      const r = await fetch("/api/me/fuel-ticket/recognize", { method: "POST", body: form })
      const body = (await r.json().catch(() => ({}))) as Proposal & { code?: string }
      if (!r.ok) { setReadNote(ERRORS[body.code ?? ""] ?? "Lecture automatique indisponible : saisissez les montants."); return }
      if (body.refund) { setReadNote("Ce ticket ressemble à un remboursement : vérifiez avant d’envoyer."); return }
      if (body.amount) setAmount(body.amount.value.replace(".", ","))
      if (body.litres) setLitres(body.litres.value.replace(".", ","))
      if (body.day && body.day.value <= today()) setDay(body.day.value)
      if (body.station) setStation(body.station.value)
      if (body.mileage) setMileage(String(body.mileage.value))
      const found = [body.amount && "montant", body.litres && "litres", body.day && "date", body.station && "station", body.mileage && "compteur"].filter(Boolean)
      setReadNote(found.length ? `Lu automatiquement : ${found.join(", ")}. Vérifiez avant d’envoyer.` : "Rien n’a pu être lu : saisissez les montants.")
    } catch {
      setReadNote("Lecture automatique indisponible : saisissez les montants.")
    } finally {
      setBusy(null)
    }
  }

  async function send() {
    if (!pending || !truckId || busy) return
    setBusy("send"); setError("")
    try {
      const form = new FormData()
      form.append("file", pending.blob, "ticket.jpg")
      form.append("payload", JSON.stringify({ truckId, amount: amount.trim(), litres: litres.trim() || null, day, station: station.trim() || null, mileage: mileage.trim() || null }))
      const r = await fetch("/api/me/fuel-ticket", { method: "POST", headers: { "Idempotency-Key": pending.key }, body: form })
      const body = (await r.json().catch(() => ({}))) as { outcome?: string; code?: string }
      if (!r.ok) { setError(ERRORS[body.code ?? ""] ?? `Envoi impossible, réessayez (le même ticket ne sera pas enregistré deux fois).${body.code ? ` Code : ${body.code}` : ""}`); return }
      setDone(body.outcome === "COMPLETED_BANK_EXPENSE"
        ? "Ticket enregistré : il complète le plein déjà relevé sur le compte bancaire."
        : "Ticket enregistré : le plein est transmis au bureau pour validation.")
    } catch {
      setError("Connexion perdue : réessayez (le même ticket ne sera pas enregistré deux fois).")
    } finally {
      setBusy(null)
    }
  }

  if (trucks === null) return <p role="status" className="text-sm text-slate-500">Chargement…</p>
  if (trucks.length === 0) return <p className="rounded-xl bg-white p-4 text-slate-700">Aucun camion ne vous est attribué comme chauffeur. Demandez au bureau de vous affecter au camion.</p>

  if (done) {
    return (
      <div className="space-y-4 rounded-2xl bg-white p-5 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden />
        <p role="status" className="text-lg font-semibold">{done}</p>
        <button className="w-full rounded-xl bg-[#0f3460] px-4 py-3 text-base font-semibold text-white" onClick={reset}>Nouveau ticket</button>
      </div>
    )
  }

  const amountOk = /^(?:0|[1-9]\d{0,7})(?:[.,]\d{1,2})?$/.test(amount.trim()) && Number(amount.replace(",", ".")) > 0
  const litresOk = !litres.trim() || /^(?:0|[1-9]\d{0,4})(?:[.,]\d{1,3})?$/.test(litres.trim())

  return (
    <div className="space-y-4">
      {trucks.length > 1 && (
        <label className="block text-sm font-medium">Camion
          <select className={input} value={truckId} onChange={(e) => { setTruckId(e.target.value); reset() }}>
            <option value="">Choisir le camion</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.matricule}{t.marque ? ` · ${t.marque}` : ""}</option>)}
          </select>
        </label>
      )}
      {trucks.length === 1 && <p className="text-sm text-slate-600">Camion : <span className="font-semibold">{trucks[0].matricule}</span></p>}

      <label className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-2xl px-4 py-5 text-lg font-semibold text-white ${truckId && !busy ? "bg-[#0f3460]" : "bg-slate-400"}`}>
        {busy === "photo" || busy === "read" ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden /> : <Camera className="h-6 w-6" aria-hidden />}
        {busy === "read" ? "Lecture du ticket…" : pending ? "Reprendre la photo" : "Photo du ticket"}
        <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={!truckId || !!busy} onChange={(e) => void onPhoto(e)} />
      </label>

      {pending && (
        <div className="space-y-4 rounded-2xl bg-white p-4 shadow-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pending.previewUrl} alt="Photo du ticket" className="mx-auto max-h-64 rounded-lg object-contain" />
          {readNote && <p className="text-sm text-slate-600">{readNote}</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Montant (€)<input className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="95,50" aria-invalid={!!amount && !amountOk} /></label>
            <label className="text-sm font-medium">Litres<input className={input} inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} placeholder="52,3" aria-invalid={!litresOk} /></label>
          </div>
          <label className="block text-sm font-medium">Date<input type="date" className={input} value={day} max={today()} onChange={(e) => setDay(e.target.value)} /></label>
          <label className="block text-sm font-medium">Compteur du camion (km), facultatif
            <input className={input} inputMode="numeric" value={mileage} onChange={(e) => setMileage(e.target.value.replace(/[^\d\s]/g, ""))} placeholder="Si vous l’avez noté" maxLength={9} />
            <span className="mt-1 block text-xs font-normal text-slate-500">Pas obligatoire : le ticket s’enregistre aussi sans.</span>
          </label>
          <label className="block text-sm font-medium">Station<input className={input} value={station} onChange={(e) => setStation(e.target.value)} placeholder="TotalEnergies Carcassonne" maxLength={200} /></label>
          <button className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50" disabled={!amountOk || !litresOk || !day || !!busy} onClick={() => void send()}>
            {busy === "send" ? "Envoi…" : "Envoyer le ticket"}
          </button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  )
}
