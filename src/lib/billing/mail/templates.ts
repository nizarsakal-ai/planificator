// Gabarits HTML/texte des courriers de facturation (pur, sans dépendance serveur). Toute valeur est échappée.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

function layout(title: string, bodyHtml: string, companyName: string): string {
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;color:#1e293b">
  <div style="background:#0f3460;color:#fff;padding:20px;border-radius:12px;text-align:center;margin-bottom:24px">
    <h1 style="margin:0;font-size:20px">${escapeHtml(companyName)}</h1></div>
  <h2 style="font-size:18px">${escapeHtml(title)}</h2>${bodyHtml}
  <p style="color:#94a3b8;font-size:12px;margin-top:32px">Courrier envoyé par Planificator pour le compte de ${escapeHtml(companyName)}.</p></div>`
}

const button = (url: string, label: string) =>
  `<p style="text-align:center;margin:28px 0"><a href="${escapeHtml(url)}" style="background:#0f3460;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`

export interface QuoteMailInput { companyName: string; clientName: string; quoteNumber: string; totalTTC: string; validUntil: string; signatureUrl: string | null }

export function quoteSentMail(i: QuoteMailInput): { subject: string; html: string; text: string } {
  const subject = `Devis ${i.quoteNumber} — ${i.companyName}`
  const html = layout(`Votre devis ${i.quoteNumber}`,
    `<p>Bonjour ${escapeHtml(i.clientName)},</p><p>Veuillez trouver votre devis d'un montant de <strong>${escapeHtml(i.totalTTC)}</strong> TTC, valable jusqu'au ${escapeHtml(i.validUntil)}.</p>`
    + (i.signatureUrl ? button(i.signatureUrl, "Consulter et signer le devis en ligne") : "") , i.companyName)
  const text = `Bonjour ${i.clientName},\nVotre devis ${i.quoteNumber} d'un montant de ${i.totalTTC} TTC est valable jusqu'au ${i.validUntil}.` + (i.signatureUrl ? `\nSigner en ligne : ${i.signatureUrl}` : "")
  return { subject, html, text }
}

export function quoteReminderMail(i: QuoteMailInput & { step: 3 | 7 | 15 }): { subject: string; html: string; text: string } {
  const subject = `Rappel : devis ${i.quoteNumber} en attente — ${i.companyName}`
  const html = layout(`Rappel concernant votre devis ${i.quoteNumber}`,
    `<p>Bonjour ${escapeHtml(i.clientName)},</p><p>Votre devis de <strong>${escapeHtml(i.totalTTC)}</strong> TTC est toujours en attente de votre réponse (valable jusqu'au ${escapeHtml(i.validUntil)}).</p>`
    + (i.signatureUrl ? button(i.signatureUrl, "Consulter et signer le devis") : ""), i.companyName)
  const text = `Bonjour ${i.clientName},\nRappel (J+${i.step}) : votre devis ${i.quoteNumber} de ${i.totalTTC} TTC est en attente, valable jusqu'au ${i.validUntil}.` + (i.signatureUrl ? `\nSigner : ${i.signatureUrl}` : "")
  return { subject, html, text }
}

export interface InvoiceMailInput { companyName: string; clientName: string; invoiceNumber: string; totalTTC: string; remaining: string; dueDate: string }

export function invoiceSentMail(i: InvoiceMailInput): { subject: string; html: string; text: string } {
  const subject = `Facture ${i.invoiceNumber} — ${i.companyName}`
  const html = layout(`Votre facture ${i.invoiceNumber}`,
    `<p>Bonjour ${escapeHtml(i.clientName)},</p><p>Votre facture d'un montant de <strong>${escapeHtml(i.totalTTC)}</strong> TTC est à régler avant le ${escapeHtml(i.dueDate)}. Reste à payer : ${escapeHtml(i.remaining)}.</p>`, i.companyName)
  const text = `Bonjour ${i.clientName},\nVotre facture ${i.invoiceNumber} de ${i.totalTTC} TTC est à régler avant le ${i.dueDate}. Reste à payer : ${i.remaining}.`
  return { subject, html, text }
}

export function invoiceReminderMail(i: InvoiceMailInput & { daysLate: number; step: 30 | 45 | 60 }): { subject: string; html: string; text: string } {
  const subject = `Relance : facture ${i.invoiceNumber} impayée — ${i.companyName}`
  const html = layout(`Relance : facture ${i.invoiceNumber}`,
    `<p>Bonjour ${escapeHtml(i.clientName)},</p><p>Sauf erreur de notre part, la facture ${escapeHtml(i.invoiceNumber)} échue le ${escapeHtml(i.dueDate)} (${i.daysLate} jours) reste impayée pour <strong>${escapeHtml(i.remaining)}</strong>. Merci de régulariser.</p>`, i.companyName)
  const text = `Bonjour ${i.clientName},\nRelance (J+${i.step}) : la facture ${i.invoiceNumber} échue le ${i.dueDate} (${i.daysLate} jours) reste impayée pour ${i.remaining}.`
  return { subject, html, text }
}
