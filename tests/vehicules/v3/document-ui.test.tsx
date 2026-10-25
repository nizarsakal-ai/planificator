// V3 Lot 1 — rendu statique de l'onglet Documents et de la fiche (aucune DB, aucun réseau).
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime"
import { VehicleDocumentCategorySection } from "@/components/vehicules/v3/VehicleDocumentCategorySection"
import { VehicleSheet, resolveSheetTab } from "@/components/vehicules/v3/VehicleSheet"
import { VehiculeCard } from "@/components/vehicules/VehiculeCard"
import {
  documentAlerts, documentStatusLabel, documentUiError, formatBytes, formatDateFr, groupDocumentsByCategory, remainingLabel,
  type DocumentView, type DocumentsSnapshot,
} from "@/components/vehicules/v3/vehicle-document-ui"

;(globalThis as { React?: typeof React }).React = React
const noop = () => {}
const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop }
const withRouter = (node: React.ReactNode) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, node))

const version = (over: Partial<DocumentView["currentVersion"] & object> = {}) => ({
  id: "v1", versionNumber: 1, status: "TO_VERIFY", originalFilename: "attestation.pdf", mimeType: "application/pdf", sizeBytes: 245_760,
  issuedOn: "2026-01-05", validFrom: "2026-01-01", validUntil: "2026-11-15", issuerName: "Assureur SA", referenceNumber: "CT-42", observations: null,
  mileage: null, maintenanceEntryId: null, uploadedAt: "2026-10-24T10:00:00.000Z", uploadedByName: "Admin A", verifiedAt: null, verifiedByName: null, supersededAt: null, ...over,
})
const document = (over: Partial<DocumentView> = {}): DocumentView => ({
  id: "d1", category: "INSURANCE", categoryLabel: "Assurance", title: "Attestation 2026", revision: 1, status: "EXPIRING", remainingDays: 22, validUntil: "2026-11-15",
  archivedAt: null, archiveReason: null, createdAt: "2026-10-24T10:00:00.000Z", createdByName: "Admin A", currentVersion: version(), ...over,
})
const snapshot: DocumentsSnapshot = {
  truckId: "truck-a", matricule: "AB-123-CD", truckActive: true, today: "2026-10-24", timezone: "Europe/Paris", thresholdsDays: [30, 7],
  visibleCategories: [{ code: "TECHNICAL_INSPECTION", label: "Contrôle technique" }, { code: "INSURANCE", label: "Assurance" }],
  documents: [document(), document({ id: "d2", title: "Ancienne attestation", status: "ARCHIVED", archivedAt: "2026-09-01T00:00:00.000Z", archiveReason: "Résiliée" })],
}

describe("V3 UI — logique d'affichage pure", () => {
  it("regroupe par rubrique visible et signale les rubriques manquantes", () => {
    const groups = groupDocumentsByCategory(snapshot)
    assert.deepEqual(groups.map((group) => [group.code, group.active.length, group.archived.length, group.missing]), [["TECHNICAL_INSPECTION", 0, 0, true], ["INSURANCE", 1, 1, false]])
    assert.deepEqual(documentAlerts(snapshot.documents), { expired: 0, expiring: 1, toVerify: 0 })
  })

  it("libellés français, sans jargon technique", () => {
    assert.equal(documentStatusLabel("NOT_YET_VALID"), "À venir")
    assert.equal(documentStatusLabel("TO_VERIFY"), "À vérifier")
    assert.equal(documentStatusLabel("HISTORICAL"), "Historique")
    assert.equal(remainingLabel({ remainingDays: 22, validUntil: "2026-11-15", status: "EXPIRING" }), "Échéance dans 22 jours")
    assert.equal(remainingLabel({ remainingDays: -3, validUntil: "2026-10-21", status: "EXPIRED" }), "Échéance dépassée depuis 3 jours")
    assert.equal(remainingLabel({ remainingDays: null, validUntil: null, status: "VALID" }), null)
    assert.equal(formatDateFr("2026-11-15"), "15/11/2026")
    assert.equal(formatBytes(245_760), "240 Ko")
    for (const code of ["DOCUMENT_ACTIVE_CONTENT", "DOCUMENT_REVISION_CONFLICT", "INVALID_ORIGIN", "FEATURE_DISABLED", undefined]) {
      const message = documentUiError(code)
      assert.doesNotMatch(message, /SQL|Prisma|Cloudinary|HTTP|JSON|idempot/i, message)
    }
  })
})

describe("V3 UI — rendu statique", () => {
  it("la rubrique affiche statut, échéance, actions privées par proxy et historique à la demande", () => {
    const html = withRouter(createElement(VehicleDocumentCategorySection, {
      truckId: "truck-a", category: { code: "INSURANCE", label: "Assurance" }, active: [document()], archived: [], canManage: true, truckActive: true, busy: false,
      expandedId: "d1", versions: { d1: [version(), version({ id: "v0", versionNumber: 0, status: "HISTORICAL", supersededAt: "2026-02-01T00:00:00.000Z" })] },
      onToggleVersions: noop, onVerify: noop, onReplace: noop, onArchive: noop, onAdd: noop,
    }))
    assert.match(html, /Bientôt échu/)
    assert.match(html, /Échéance dans 22 jours/)
    assert.match(html, /Assureur SA/)
    assert.match(html, /href="\/api\/trucks\/truck-a\/documents\/d1\/versions\/v1\/file"/)
    assert.match(html, /href="\/api\/trucks\/truck-a\/documents\/d1\/versions\/v1\/file\?dl=1"/)
    assert.match(html, /Marquer comme vérifié/)
    assert.match(html, /Remplacer/)
    assert.match(html, /Historique/)
    assert.doesNotMatch(html, /cloudinary|signature|storageKey/i)
  })

  it("lecture seule : aucune action d'écriture pour un chef d'équipe ni sur un camion archivé ; rubrique vide = manquant", () => {
    const readOnly = withRouter(createElement(VehicleDocumentCategorySection, {
      truckId: "truck-a", category: { code: "INSURANCE", label: "Assurance" }, active: [document()], archived: [], canManage: false, truckActive: true, busy: false,
      expandedId: null, versions: {}, onToggleVersions: noop, onVerify: noop, onReplace: noop, onArchive: noop, onAdd: noop,
    }))
    assert.doesNotMatch(readOnly, /Marquer comme vérifié|Remplacer|Archiver|Ajouter une pièce/)
    assert.match(readOnly, /Consulter/)
    const archivedTruck = withRouter(createElement(VehicleDocumentCategorySection, {
      truckId: "truck-a", category: { code: "TECHNICAL_INSPECTION", label: "Contrôle technique" }, active: [], archived: [], canManage: true, truckActive: false, busy: false,
      expandedId: null, versions: {}, onToggleVersions: noop, onVerify: noop, onReplace: noop, onArchive: noop, onAdd: noop,
    }))
    assert.match(archivedTruck, /Manquant/)
    assert.doesNotMatch(archivedTruck, /Ajouter une pièce/)
  })

  it("la fiche affiche l'identité du camion et l'onglet Documents ; la carte n'expose le lien qu'avec le prototype activé", () => {
    const sheet = withRouter(createElement(VehicleSheet, { canManage: true, initialTab: "documents", truck: { id: "truck-a", matricule: "AB-123-CD", marque: "Renault", modele: "Master", active: true, archivedAt: null, teamName: "Équipe Nord", chauffeurName: "Hélène Dupont" } }))
    assert.match(sheet, /AB-123-CD/)
    assert.match(sheet, /Renault Master · Équipe Nord · Hélène Dupont/)
    const navigation = sheet.match(/<nav aria-label="Rubriques du camion"[^>]*>[\s\S]*?<\/nav>/)?.[0]
    assert.ok(navigation, "la fiche expose une navigation accessible entre toutes les rubriques")
    assert.match(navigation, /<a[^>]*aria-current="page"[^>]*href="\/vehicules\/truck-a"[^>]*>Documents<\/a>/)
    assert.equal((navigation.match(/aria-current="page"/g) ?? []).length, 1)
    assert.match(navigation, /href="\/vehicules\/truck-a\/tournees"[^>]*>Tournées<\/a>/)
    assert.match(navigation, /href="\/vehicules\/truck-a\/couts"[^>]*>Carburant et coûts<\/a>/)
    assert.match(navigation, /href="\/vehicules\/truck-a\/imports"[^>]*>Importer des adresses<\/a>/)
    assert.match(sheet, /Documents du véhicule/)
    assert.equal(resolveSheetTab("inconnu"), "documents")
    const truck = { id: "truck-a", matricule: "AB-123-CD", marque: null, modele: null, active: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", team: null, chauffeur: null, history: [], historyTruncated: false }
    const cardProps = { truck, teams: [], employees: [], layout: "grid" as const, loading: false, historyOpen: false, onToggleHistory: noop, onEdit: noop, onArchive: noop, onRestore: noop, onAssign: noop }
    assert.doesNotMatch(withRouter(createElement(VehiculeCard, cardProps)), /Documents du véhicule/)
    assert.match(withRouter(createElement(VehiculeCard, { ...cardProps, sheetHref: "/vehicules/truck-a" })), /href="\/vehicules\/truck-a"[^>]*aria-label="Documents du véhicule AB-123-CD"|aria-label="Documents du véhicule AB-123-CD"/)
  })
})
