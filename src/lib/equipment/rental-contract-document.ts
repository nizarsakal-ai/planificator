/**
 * Contrat de location de matériel complet, pré-établi : un modèle type (conditions particulières + conditions
 * générales) rempli avec les données du contrat enregistré (loueur, locataire, équipement, chantier, période, prix).
 * Logique pure, sans accès base ni horloge : testable et rendue telle quelle par la page d'impression.
 * Aucune donnée n'est inventée : un champ absent laisse une ligne à compléter à la main.
 */
import { billedDays, committedRentalCents } from "@/lib/equipment/equipment.core"
import { formatEuro } from "@/lib/billing/money"

export const BLANK = "________________"

export type RentalContractDocumentInput = {
  number: string
  status: "ACTIVE" | "CLOSED" | "CANCELLED"
  startDate: Date
  endDate: Date
  returnedOn: Date | null
  dailyRateCents: number
  fixedFeesCents: number
  costCents: bigint | null
  notes: string | null
  createdAt: Date
  company: { name: string; address: string | null; siret: string | null; phone: string | null; email: string | null }
  supplier: { name: string; address: string | null; siret: string | null; vatNumber: string | null; email: string | null }
  equipment: { number: string; name: string; category: string; serialNumber: string | null; condition: string }
  worksite: { name: string; address: string | null } | null
}

export type ContractParty = { role: string; name: string; lines: string[] }
export type ContractArticle = { title: string; paragraphs: string[] }
export type ContractDocument = {
  title: string
  reference: string
  statusNote: string | null
  lessor: ContractParty
  lessee: ContractParty
  particular: { label: string; value: string }[]
  articles: ContractArticle[]
}

const CONDITION_FR: Record<string, string> = { GOOD: "bon état", WORN: "usé", DAMAGED: "endommagé" }
const longDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
/** Jour stocké à minuit UTC → « 11 novembre 2026 ». */
export const fmtLongDay = (d: Date) => longDay.format(d)
const eur = (cents: number | bigint) => formatEuro(BigInt(cents))
const or = (v: string | null | undefined) => (v && v.trim() ? v.trim() : BLANK)

function party(role: string, p: { name: string; address: string | null; siret: string | null; email: string | null; phone?: string | null; vatNumber?: string | null }): ContractParty {
  const lines = [`Adresse : ${or(p.address)}`, `SIRET : ${or(p.siret)}`]
  if (p.vatNumber !== undefined) lines.push(`N° TVA intracommunautaire : ${or(p.vatNumber)}`)
  if (p.phone !== undefined) lines.push(`Téléphone : ${or(p.phone)}`)
  lines.push(`E-mail : ${or(p.email)}`, `Représenté par : ${BLANK}, en qualité de ${BLANK}`)
  return { role, name: p.name, lines }
}

type ConditionsInput = {
  lessorName: string; lesseeName: string; equipment: RentalContractDocumentInput["equipment"]
  start: Date; end: Date; days: number; site: string | null; priceSentence: string; notes: string | null
}

/** Conditions générales communes aux contrats fournisseur (la société loue) et client (la société donne en location). */
function generalConditions(o: ConditionsInput): ContractArticle[] {
  const articles: ContractArticle[] = [
    { title: "Objet", paragraphs: [
      `Le présent contrat a pour objet la location, par ${o.lessorName} (le « Loueur ») à ${o.lesseeName} (le « Locataire »), du matériel désigné aux conditions particulières, pour les besoins de l'activité professionnelle du Locataire.`,
      "Le contrat se compose des conditions particulières ci-dessus et des présentes conditions générales. En cas de contradiction, les conditions particulières prévalent.",
    ] },
    { title: "Désignation et état du matériel", paragraphs: [
      `Le matériel loué est : ${o.equipment.name}, catégorie ${o.equipment.category}, référence interne ${o.equipment.number}, n° de série ${or(o.equipment.serialNumber)}.`,
      `Il est remis en ${CONDITION_FR[o.equipment.condition] ?? BLANK}, en ordre de marche, avec ses accessoires et la documentation nécessaire à son utilisation. Un état contradictoire est établi à la mise à disposition ; à défaut de réserve écrite, le matériel est réputé conforme et en bon état.`,
    ] },
    { title: "Durée", paragraphs: [
      `La location prend effet le ${fmtLongDay(o.start)} et prend fin le ${fmtLongDay(o.end)}, soit ${o.days} jour${o.days > 1 ? "s" : ""} calendaire${o.days > 1 ? "s" : ""}, premier et dernier jour inclus.`,
      "Toute prolongation fait l'objet d'un accord écrit préalable (courriel accepté). À défaut, la conservation du matériel au-delà de la date de fin est facturée au tarif journalier, sans préjudice des droits du Loueur.",
      "Une restitution anticipée réduit la durée facturée aux jours réellement écoulés, sauf minimum de facturation prévu aux conditions particulières.",
    ] },
    { title: "Lieu d'utilisation", paragraphs: [
      o.site
        ? `Le matériel est utilisé exclusivement sur le chantier ${o.site}.`
        : `Le matériel est utilisé exclusivement à l'adresse suivante : ${BLANK}.`,
      "Il ne peut être déplacé vers un autre site, ni sorti du territoire français, sans l'accord écrit du Loueur.",
    ] },
    { title: "Prix et conditions de paiement", paragraphs: [
      o.priceSentence,
      "Les prix s'entendent hors taxes ; la TVA est due en sus au taux en vigueur. Le montant définitif est arrêté sur les jours réels de location, constatés à la restitution.",
      "Sauf conditions particulières, les factures sont payables à trente (30) jours à compter de leur date d'émission. Tout retard de paiement entraîne de plein droit des pénalités au taux prévu par l'article L. 441-10 du Code de commerce et une indemnité forfaitaire pour frais de recouvrement de 40 €.",
    ] },
    { title: "Dépôt de garantie", paragraphs: [
      "Le Loueur peut exiger un dépôt de garantie, dont le montant figure aux conditions particulières. Il ne constitue pas une limite de responsabilité du Locataire et est restitué après restitution du matériel et apurement des sommes dues.",
    ] },
    { title: "Mise à disposition, transport et installation", paragraphs: [
      "Le matériel est mis à disposition au lieu convenu. Le transport aller et retour est à la charge de la partie qui l'organise, selon les conditions particulières ; les risques du transport incombent à cette partie.",
      "Le Locataire vérifie le matériel à la livraison et formule par écrit ses éventuelles réserves au plus tard à la première mise en service.",
    ] },
    { title: "Utilisation", paragraphs: [
      "Le Locataire utilise le matériel en bon professionnel, conformément à sa destination, à la notice du constructeur et à la réglementation en vigueur, notamment en matière d'hygiène et de sécurité du travail.",
      "Il le confie uniquement à un personnel qualifié, formé et, lorsque la réglementation l'exige, titulaire d'une autorisation de conduite ou d'un CACES valide.",
      "Toute sous-location, prêt ou cession, même à titre gratuit, est interdite sans accord écrit du Loueur.",
    ] },
    { title: "Entretien et vérifications", paragraphs: [
      "Le Locataire assure l'entretien courant (nettoyage, niveaux, graissage, contrôle quotidien) et utilise les consommables préconisés.",
      "Les révisions, réparations et vérifications générales périodiques réglementaires restent à la charge du Loueur, sauf si elles résultent d'une faute ou d'une mauvaise utilisation du Locataire. Le Locataire laisse le Loueur accéder au matériel à cette fin.",
    ] },
    { title: "Garde, responsabilité et assurance", paragraphs: [
      "Pendant toute la durée de la location, de la mise à disposition jusqu'à la restitution, le Locataire a la garde juridique du matériel et répond des dommages qu'il subit ou qu'il cause.",
      "Le Locataire justifie, à première demande, d'une assurance responsabilité civile couvrant l'utilisation du matériel et des dommages au matériel loué (vol, incendie, bris), sauf renonciation à recours ou garantie souscrite auprès du Loueur aux conditions particulières.",
    ] },
    { title: "Panne, sinistre et vol", paragraphs: [
      "Le Locataire informe le Loueur sans délai de toute panne ou anomalie et cesse d'utiliser le matériel si la sécurité l'exige. Il s'interdit toute réparation non autorisée.",
      "En cas de vol ou de sinistre, il prévient le Loueur dans les vingt-quatre (24) heures et, en cas de vol, dépose plainte dans les quarante-huit (48) heures et en remet la copie au Loueur. La location reste due jusqu'à cette déclaration.",
      "Une immobilisation due à une panne non imputable au Locataire n'est pas facturée, dès lors qu'elle a été signalée.",
    ] },
    { title: "Restitution", paragraphs: [
      "Le matériel est restitué à la date de fin, au lieu convenu, complet, nettoyé et dans l'état où il a été remis, sous réserve de l'usure normale. Un état contradictoire de retour est établi.",
      "Les dommages, pièces manquantes ou frais de remise en état constatés au retour, hors usure normale, sont facturés au Locataire sur justificatif.",
    ] },
    { title: "Propriété du matériel", paragraphs: [
      "Le matériel demeure la propriété exclusive du Loueur. Le Locataire s'interdit d'en disposer, de le grever d'un droit quelconque ou d'en modifier les marquages, et informe sans délai le Loueur de toute saisie ou revendication d'un tiers.",
    ] },
    { title: "Résiliation", paragraphs: [
      "En cas de manquement de l'une des parties à ses obligations, l'autre partie peut résilier le contrat de plein droit, huit (8) jours après une mise en demeure restée sans effet, adressée par lettre recommandée avec accusé de réception ou par courriel avec accusé de lecture.",
      "La résiliation entraîne la restitution immédiate du matériel et le paiement des sommes dues à la date de restitution.",
    ] },
    { title: "Droit applicable et litiges", paragraphs: [
      "Le présent contrat est soumis au droit français. Les parties recherchent une solution amiable avant toute action. À défaut, tout litige relève du tribunal de commerce du ressort du siège social du Loueur.",
    ] },
  ]
  if (o.notes?.trim()) articles.push({ title: "Conditions particulières complémentaires", paragraphs: [o.notes.trim()] })
  return articles
}

export function buildRentalContractDocument(c: RentalContractDocumentInput): ContractDocument {
  const days = billedDays(c.startDate, c.endDate)
  const committed = committedRentalCents(c)
  const site = c.worksite ? `${c.worksite.name}${c.worksite.address ? `, ${c.worksite.address}` : ""}` : null
  const closed = c.status === "CLOSED" && c.returnedOn
  const realDays = closed ? billedDays(c.startDate, c.returnedOn!) : null

  const particular: { label: string; value: string }[] = [
    { label: "Matériel", value: `${c.equipment.name} (réf. interne ${c.equipment.number})` },
    { label: "Catégorie", value: c.equipment.category },
    { label: "N° de série", value: or(c.equipment.serialNumber) },
    { label: "Début de location", value: fmtLongDay(c.startDate) },
    { label: "Fin prévue", value: fmtLongDay(c.endDate) },
    { label: "Durée prévue", value: `${days} jour${days > 1 ? "s" : ""} calendaire${days > 1 ? "s" : ""} (bornes incluses)` },
    { label: "Lieu d'utilisation", value: site ?? BLANK },
    { label: "Tarif journalier HT", value: eur(c.dailyRateCents) },
    { label: "Frais fixes HT (transport, livraison…)", value: eur(c.fixedFeesCents) },
    { label: "Montant prévisionnel HT", value: eur(committed) },
    { label: "Dépôt de garantie", value: `${BLANK} € (le cas échéant)` },
  ]
  if (closed) {
    particular.push({ label: "Restitution effective", value: fmtLongDay(c.returnedOn!) })
    particular.push({ label: "Montant définitif HT", value: `${eur(c.costCents ?? BigInt(0))} (${realDays} jour${realDays! > 1 ? "s" : ""})` })
  }

  const articles = generalConditions({
    lessorName: c.supplier.name, lesseeName: c.company.name, equipment: c.equipment, start: c.startDate, end: c.endDate, days, site, notes: c.notes,
    priceSentence: `Le loyer est fixé à ${eur(c.dailyRateCents)} HT par jour calendaire, auquel s'ajoutent ${eur(c.fixedFeesCents)} HT de frais fixes (transport, livraison, reprise). Le montant prévisionnel s'élève à ${eur(committed)} HT pour la durée prévue.`,
  })

  const statusNote = c.status === "CANCELLED"
    ? "Contrat annulé : document conservé pour mémoire, sans effet."
    : closed ? `Contrat clôturé : matériel restitué le ${fmtLongDay(c.returnedOn!)}.` : null

  return {
    title: "Contrat de location de matériel",
    reference: `Contrat n° ${c.number} établi le ${fmtLongDay(c.createdAt)}`,
    statusNote,
    lessor: party("Le Loueur", c.supplier),
    lessee: party("Le Locataire", { ...c.company, vatNumber: undefined }),
    particular,
    articles,
  }
}

const pad = (n: number) => String(n).padStart(2, "0")
/** Numéro de contrat client déterministe : équipement + premier jour (une réservation ne chevauche jamais une autre). */
export const bookingContractNumber = (equipmentNumber: string, firstDay: Date) =>
  `LOC-${equipmentNumber}-${firstDay.getUTCFullYear()}${pad(firstDay.getUTCMonth() + 1)}${pad(firstDay.getUTCDate())}`

export type BookingContractDocumentInput = {
  status: "RESERVED" | "CHECKED_OUT" | "RETURNED" | "CANCELLED"
  firstDay: Date
  lastDay: Date
  depositCents: number | null
  checkoutCondition: string | null
  returnedAt: Date | null
  createdAt: Date
  company: RentalContractDocumentInput["company"]
  client: { name: string; address: string | null; siret: string | null; vatNumber: string | null; phone: string | null; email: string | null } | null
  equipment: RentalContractDocumentInput["equipment"]
  worksite: { name: string; address: string | null } | null
  responsible: string | null
}

/**
 * Contrat établi automatiquement quand la société donne un matériel en location (réservation / sortie) : la société
 * est le Loueur, le client du chantier (événement) est le Locataire. Seule la période vient de la saisie ; le prix
 * renvoie au devis, aucune donnée commerciale n'est inventée.
 */
export function buildBookingContractDocument(b: BookingContractDocumentInput): ContractDocument {
  const days = billedDays(b.firstDay, b.lastDay)
  const site = b.worksite ? `${b.worksite.name}${b.worksite.address ? `, ${b.worksite.address}` : ""}` : null
  const equipment = { ...b.equipment, condition: b.checkoutCondition ?? b.equipment.condition }
  const lesseeName = b.client?.name ?? BLANK
  const particular = [
    { label: "Matériel", value: `${b.equipment.name} (réf. ${b.equipment.number})` },
    { label: "Catégorie", value: b.equipment.category },
    { label: "N° de série", value: or(b.equipment.serialNumber) },
    { label: "Début de location", value: fmtLongDay(b.firstDay) },
    { label: "Fin de location", value: fmtLongDay(b.lastDay) },
    { label: "Durée", value: `${days} jour${days > 1 ? "s" : ""} calendaire${days > 1 ? "s" : ""} (bornes incluses)` },
    { label: "Événement / lieu d'utilisation", value: site ?? BLANK },
    { label: "Prix de la location HT", value: `Selon devis n° ${BLANK}` },
    { label: "Dépôt de garantie", value: b.depositCents !== null ? eur(b.depositCents) : `${BLANK} € (le cas échéant)` },
    { label: "Responsable côté Loueur", value: or(b.responsible) },
  ]
  const statusNote = b.status === "CANCELLED" ? "Réservation annulée : document conservé pour mémoire, sans effet."
    : b.returnedAt ? "Matériel restitué : contrat exécuté." : null
  return {
    title: "Contrat de location de matériel événementiel",
    reference: `Contrat n° ${bookingContractNumber(b.equipment.number, b.firstDay)} établi le ${fmtLongDay(b.createdAt)}`,
    statusNote,
    lessor: party("Le Loueur", b.company),
    lessee: b.client ? party("Le Locataire", b.client) : { role: "Le Locataire", name: BLANK, lines: [`Adresse : ${BLANK}`, `SIRET : ${BLANK}`, `Téléphone : ${BLANK}`, `E-mail : ${BLANK}`, `Représenté par : ${BLANK}, en qualité de ${BLANK}`] },
    particular,
    articles: generalConditions({
      lessorName: b.company.name, lesseeName, equipment, start: b.firstDay, end: b.lastDay, days, site, notes: null,
      priceSentence: `Le prix de la location, le transport, le montage et le démontage éventuels sont fixés au devis n° ${BLANK} accepté par le Locataire, qui fait partie intégrante du présent contrat.`,
    }),
  }
}
