// Module Tâches V1 — Intégration additive au dashboard de gestion (contrôles statiques de source).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const page = readFileSync("src/app/(dashboard)/dashboard/page.tsx", "utf8")
const form = readFileSync("src/components/tasks/TaskForm.tsx", "utf8")
const dialog = readFileSync("src/components/tasks/NouvelleTacheDialog.tsx", "utf8")

/** Corps d'une fonction `async function Name(` jusqu'à la prochaine déclaration de fonction/section. */
function fnBody(name: string): string {
  const start = page.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${name} introuvable`)
  const after = page.slice(start + name.length)
  const nextFn = after.indexOf("async function ")
  const nextMarker = after.indexOf("export default")
  const end = Math.min(
    ...[nextFn, nextMarker].filter((i) => i > 0)
  )
  return after.slice(0, end > 0 ? end : after.length)
}

describe("Dashboard — intégration du bouton Nouvelle tâche", () => {
  it("le dialogue est importé et rendu dans AdminDashboard", () => {
    assert.match(page, /import \{ NouvelleTacheDialog \} from "@\/components\/tasks\/NouvelleTacheDialog"/)
    const admin = fnBody("AdminDashboard")
    assert.match(admin, /<NouvelleTacheDialog\s+employees=\{taskEmployees\}\s+worksites=\{taskWorksites\}\s*\/>/)
  })

  it("AdminDashboard charge employés/chantiers filtrés par companyId", () => {
    const admin = fnBody("AdminDashboard")
    assert.match(
      admin,
      /prisma\.employee\.findMany\(\{\s*where:\s*\{\s*companyId,\s*active:\s*true\s*\}/
    )
    assert.match(admin, /prisma\.worksite\.findMany\(\{\s*where:\s*\{\s*companyId\s*\}/)
    // Sélection minimale
    assert.match(admin, /select:\s*\{\s*id:\s*true,\s*firstName:\s*true,\s*lastName:\s*true\s*\}/)
    assert.match(admin, /select:\s*\{\s*id:\s*true,\s*name:\s*true\s*\}/)
  })

  it("les KPIs existants sont préservés", () => {
    const admin = fnBody("AdminDashboard")
    assert.match(admin, /title="Employés"/)
    assert.match(admin, /title="Chantiers actifs"/)
    assert.match(admin, /WorksiteStatusChart/)
  })

  it("le bouton n'apparaît PAS dans les autres dashboards", () => {
    for (const name of ["SuperAdminDashboard", "TeamLeaderDashboard", "EmployeeDashboard"]) {
      assert.doesNotMatch(fnBody(name), /NouvelleTacheDialog/, name)
    }
  })

  it("aucune requête Tâches déplacée dans les branches non-gestion", () => {
    for (const name of ["TeamLeaderDashboard", "EmployeeDashboard"]) {
      assert.doesNotMatch(fnBody(name), /prisma\.task\./, name)
      assert.doesNotMatch(fnBody(name), /taskEmployees|taskWorksites/, name)
    }
  })
})

describe("TaskForm — contenu", () => {
  it("option « Aucun » pour employé et chantier (listes vides tolérées)", () => {
    assert.equal((form.match(/<option value="">Aucun<\/option>/g) ?? []).length, 2)
    // Les listes sont mappées sans garde empêchant la création quand elles sont vides.
    assert.match(form, /employees\.map\(/)
    assert.match(form, /worksites\.map\(/)
  })

  it("libellés français des statuts et priorités", () => {
    assert.match(form, /TASK_STATUS_LABELS/)
    assert.match(form, /TASK_PRIORITY_LABELS/)
  })

  it("soumission déléguée à submitTaskForm (action createTask injectée), toasts et pending", () => {
    assert.match(form, /from "@\/lib\/actions\/task\.actions"/)
    assert.match(form, /from "@\/lib\/tasks\/task-form\.submit"/)
    assert.match(form, /submitTaskForm\(/)
    assert.match(form, /createTask,/)
    assert.match(form, /toast\.success/)
    assert.match(form, /toast\.error/)
    assert.match(form, /isSubmitting/)
  })
})

describe("NouvelleTacheDialog — contenu", () => {
  it("bouton « Nouvelle tâche » et fermeture après succès", () => {
    assert.match(dialog, /Nouvelle tâche/)
    assert.match(dialog, /onSuccess=\{\(\) => setOpen\(false\)\}/)
  })
})
