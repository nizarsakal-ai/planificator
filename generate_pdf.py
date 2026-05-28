from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, Preformatted
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import datetime

OUTPUT_PATH = "/Users/nohisac/Desktop/Planificator/Planificator_Architecture.pdf"

# ─── Document ────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUTPUT_PATH,
    pagesize=A4,
    rightMargin=2*cm,
    leftMargin=2*cm,
    topMargin=2.5*cm,
    bottomMargin=2*cm,
    title="Planificator - Architecture & Schéma de Base de Données",
    author="Firas HACHANI",
)

W, H = A4

# ─── Couleurs ────────────────────────────────────────────────────────────────
DARK        = colors.HexColor("#1a1a2e")
PRIMARY     = colors.HexColor("#0f3460")
ACCENT      = colors.HexColor("#16213e")
LIGHT_BLUE  = colors.HexColor("#e8f4fd")
CODE_BG     = colors.HexColor("#1e1e2e")
CODE_FG     = colors.HexColor("#cdd6f4")
GRAY        = colors.HexColor("#6b7280")
BORDER      = colors.HexColor("#e5e7eb")
GREEN       = colors.HexColor("#10b981")
ORANGE      = colors.HexColor("#f59e0b")
WHITE       = colors.white

# ─── Styles ──────────────────────────────────────────────────────────────────
styles = getSampleStyleSheet()

style_title = ParagraphStyle(
    "MainTitle", fontSize=28, textColor=WHITE, alignment=TA_CENTER,
    spaceAfter=6, fontName="Helvetica-Bold", leading=34,
)
style_subtitle = ParagraphStyle(
    "SubTitle", fontSize=13, textColor=colors.HexColor("#a5b4fc"),
    alignment=TA_CENTER, spaceAfter=4, fontName="Helvetica",
)
style_meta = ParagraphStyle(
    "Meta", fontSize=9, textColor=colors.HexColor("#9ca3af"),
    alignment=TA_CENTER, fontName="Helvetica",
)
style_h1 = ParagraphStyle(
    "H1", fontSize=18, textColor=PRIMARY, spaceBefore=18, spaceAfter=8,
    fontName="Helvetica-Bold", borderPad=4,
)
style_h2 = ParagraphStyle(
    "H2", fontSize=13, textColor=ACCENT, spaceBefore=12, spaceAfter=6,
    fontName="Helvetica-Bold",
)
style_h3 = ParagraphStyle(
    "H3", fontSize=11, textColor=PRIMARY, spaceBefore=8, spaceAfter=4,
    fontName="Helvetica-Bold",
)
style_body = ParagraphStyle(
    "Body", fontSize=9.5, textColor=colors.HexColor("#374151"),
    spaceAfter=5, fontName="Helvetica", leading=14, alignment=TA_JUSTIFY,
)
style_body_fr = ParagraphStyle(
    "BodyFr", fontSize=9.5, textColor=colors.HexColor("#374151"),
    spaceAfter=4, fontName="Helvetica", leading=14,
)
style_code = ParagraphStyle(
    "Code", fontSize=7.5, textColor=CODE_FG, fontName="Courier",
    leading=11, spaceAfter=2, backColor=CODE_BG,
    leftIndent=8, rightIndent=8,
)
style_bullet = ParagraphStyle(
    "Bullet", fontSize=9.5, textColor=colors.HexColor("#374151"),
    spaceAfter=3, fontName="Helvetica", leading=13,
    leftIndent=14, bulletIndent=4,
)
style_label_user = ParagraphStyle(
    "LabelUser", fontSize=8, textColor=WHITE, fontName="Helvetica-Bold",
    alignment=TA_CENTER,
)
style_label_ai = ParagraphStyle(
    "LabelAI", fontSize=8, textColor=WHITE, fontName="Helvetica-Bold",
    alignment=TA_CENTER,
)
style_note = ParagraphStyle(
    "Note", fontSize=8.5, textColor=colors.HexColor("#92400e"),
    fontName="Helvetica-Oblique", leading=12,
)

# ─── Helpers ─────────────────────────────────────────────────────────────────
def hr(color=BORDER, thickness=0.8):
    return HRFlowable(width="100%", thickness=thickness, color=color, spaceAfter=6, spaceBefore=6)

def section_title(text):
    return [
        Spacer(1, 0.3*cm),
        Paragraph(text, style_h1),
        hr(PRIMARY, 1.5),
    ]

def subsection(text):
    return [Paragraph(text, style_h2)]

def code_block(code_text):
    items = [Spacer(1, 0.15*cm)]
    for line in code_text.split("\n"):
        safe = (line
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))
        items.append(Paragraph(safe if safe else " ", style_code))
    items.append(Spacer(1, 0.15*cm))
    return items

def bullet(text):
    return Paragraph(f"&#8226;&nbsp;&nbsp;{text}", style_bullet)

def role_badge(role, bg):
    data = [[Paragraph(role, ParagraphStyle("rb", fontSize=7.5, textColor=WHITE,
                        fontName="Helvetica-Bold", alignment=TA_CENTER))]]
    t = Table(data, colWidths=[2.8*cm], rowHeights=[0.45*cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), bg),
        ("ROUNDEDCORNERS", [4]),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("TOPPADDING", (0,0), (-1,-1), 2),
        ("BOTTOMPADDING", (0,0), (-1,-1), 2),
    ]))
    return t

# ─── Cover Page ──────────────────────────────────────────────────────────────
def build_cover():
    items = []

    # Background header block
    cover_data = [[
        Paragraph("PLANIFICATOR", style_title),
    ]]
    cover_table = Table(cover_data, colWidths=[17*cm], rowHeights=[3*cm])
    cover_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), PRIMARY),
        ("VALIGN",     (0,0), (-1,-1), "MIDDLE"),
        ("TOPPADDING", (0,0), (-1,-1), 24),
        ("BOTTOMPADDING", (0,0), (-1,-1), 24),
        ("ROUNDEDCORNERS", [8]),
    ]))
    items.append(Spacer(1, 1*cm))
    items.append(cover_table)
    items.append(Spacer(1, 0.4*cm))
    items.append(Paragraph("Architecture Technique &amp; Schéma de Base de Données", style_subtitle))
    items.append(Paragraph("Version 1.0 — Document de Référence", style_meta))
    items.append(Spacer(1, 0.6*cm))
    items.append(hr(colors.HexColor("#a5b4fc"), 1))
    items.append(Spacer(1, 0.4*cm))

    # Info table
    info_data = [
        ["Projet",    "Planificator"],
        ["Auteur",    "Firas HACHANI"],
        ["Date",      datetime.date.today().strftime("%d/%m/%Y")],
        ["Version",   "V1.0"],
        ["Stack",     "Next.js 14 · TypeScript · PostgreSQL · Prisma · NextAuth v5"],
        ["Statut",    "Architecture validée — prêt pour développement"],
    ]
    info_style = [
        ("BACKGROUND", (0,0), (0,-1), LIGHT_BLUE),
        ("TEXTCOLOR",  (0,0), (0,-1), PRIMARY),
        ("FONTNAME",   (0,0), (0,-1), "Helvetica-Bold"),
        ("FONTNAME",   (1,0), (1,-1), "Helvetica"),
        ("FONTSIZE",   (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING", (0,0), (0,-1), 10),
        ("LEFTPADDING", (1,0), (1,-1), 10),
        ("GRID", (0,0), (-1,-1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (1,0), (1,-1), [WHITE, colors.HexColor("#f9fafb")]),
    ]
    info_t = Table(info_data, colWidths=[4*cm, 13*cm])
    info_t.setStyle(TableStyle(info_style))
    items.append(info_t)
    items.append(Spacer(1, 0.8*cm))

    # Description
    items.append(Paragraph(
        "Ce document présente l'architecture complète de l'application <b>Planificator</b>, "
        "une solution SaaS multi-entreprises de gestion de planning, d'équipes, d'employés, "
        "de clients et de chantiers. Il contient l'architecture technique recommandée, "
        "la structure des dossiers, le schéma de base de données Prisma complet, "
        "la matrice des rôles, les routes API, et le plan de développement.",
        style_body
    ))
    items.append(PageBreak())
    return items

# ─── Section 1 : Contexte & Besoins ─────────────────────────────────────────
def build_section_context():
    items = []
    items += section_title("1. Contexte &amp; Besoins")

    items.append(Paragraph(
        "Planificator est une application web de gestion de planning pensée dès le départ "
        "pour un déploiement multi-entreprises (SaaS). Chaque entreprise dispose de ses propres "
        "données isolées. L'objectif V1 est un usage interne, avec une commercialisation possible à terme.",
        style_body
    ))
    items.append(Spacer(1, 0.3*cm))

    items += subsection("Règles Métier Clés")
    rules = [
        "Une équipe contient généralement 5 ou 6 employés",
        "Chaque équipe a toujours un chef d'équipe obligatoire",
        "Un employé peut changer d'équipe",
        "Un employé ne peut pas être affecté à deux chantiers différents le même jour",
        "Une équipe ne peut pas être affectée à deux chantiers différents le même jour",
        "La planification se fait par journée complète (généralement 10h)",
        "L'admin crée les chantiers et attribue les équipes",
        "L'employé consulte uniquement son planning",
        "Le chef d'équipe consulte le planning de son équipe",
        "Le client consulte uniquement ses chantiers et le planning lié",
        "Archivage automatique d'un chantier terminé après 48h",
        "Pas d'inscription libre — invitation par email uniquement",
    ]
    for r in rules:
        items.append(bullet(r))
    items.append(Spacer(1, 0.3*cm))

    items += subsection("Fonctionnalités V1 (20 points)")
    features = [
        ("01", "Authentification email + mot de passe"),
        ("02", "Invitation utilisateur par email"),
        ("03", "Reset mot de passe"),
        ("04", "Gestion multi-entreprises"),
        ("05", "Gestion des rôles"),
        ("06", "Dashboard admin"),
        ("07", "Création des employés"),
        ("08", "Création des équipes"),
        ("09", "Chef d'équipe obligatoire"),
        ("10", "Création des clients"),
        ("11", "Création des chantiers"),
        ("12", "Ajout description, plan, photo et documents au chantier"),
        ("13", "Attribution d'une équipe à un chantier"),
        ("14", "Planning jour / semaine / mois"),
        ("15", "Planning par employé"),
        ("16", "Planning par équipe"),
        ("17", "Accès client limité à ses propres chantiers"),
        ("18", "Confirmation ou refus d'une affectation avec champ raison"),
        ("19", "Archivage automatique d'un chantier terminé après 48h"),
        ("20", "Fonction prolonger un chantier + historique des modifications"),
    ]
    feat_data = [["#", "Fonctionnalité"]] + features
    feat_t = Table(feat_data, colWidths=[1.2*cm, 15.8*cm])
    feat_t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PRIMARY),
        ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 8.5),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f8fafc")]),
        ("TEXTCOLOR", (0,1), (0,-1), PRIMARY),
        ("FONTNAME", (0,1), (0,-1), "Helvetica-Bold"),
        ("ALIGN", (0,0), (0,-1), "CENTER"),
    ]))
    items.append(feat_t)
    items.append(PageBreak())
    return items

# ─── Section 2 : Architecture Technique ─────────────────────────────────────
def build_section_architecture():
    items = []
    items += section_title("2. Architecture Technique")

    items += subsection("Stack Technologique")
    stack = [
        ["Couche", "Technologie", "Rôle"],
        ["Framework",    "Next.js 14 (App Router)",      "SSR, routing, Server Actions"],
        ["Langage",      "TypeScript",                   "Typage statique"],
        ["Base de données", "PostgreSQL",                "BDD relationnelle"],
        ["ORM",          "Prisma",                       "Accès BDD typé"],
        ["Authentification", "NextAuth v5 (Auth.js)",    "Sessions, JWT, OAuth futur"],
        ["UI",           "Tailwind CSS + shadcn/ui",     "Design system"],
        ["Planning",     "react-big-calendar",           "Calendrier interactif"],
        ["Email",        "Resend",                       "Invitations, reset password"],
        ["Upload",       "UploadThing",                  "Fichiers, plans, photos"],
        ["Validation",   "Zod",                          "Schemas de validation"],
        ["État serveur", "Server Actions + React Query", "Mutations et cache"],
    ]
    stack_t = Table(stack, colWidths=[4*cm, 6*cm, 7*cm])
    stack_t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PRIMARY),
        ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTNAME",   (0,1), (0,-1), "Helvetica-Bold"),
        ("TEXTCOLOR",  (0,1), (0,-1), PRIMARY),
        ("FONTSIZE",   (0,0), (-1,-1), 8.5),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f0f9ff")]),
    ]))
    items.append(stack_t)
    items.append(Spacer(1, 0.4*cm))

    items += subsection("Stratégie Multi-Tenant")
    items.append(Paragraph(
        "Isolation par colonne <b>companyId</b> (row-level isolation). Simple, robuste, "
        "suffisant pour V1. Chaque requête Prisma filtre obligatoirement par companyId "
        "via un middleware Prisma. Le champ <b>slug</b> sur Company prépare la migration "
        "vers des sous-domaines (ex: acme.planificator.fr).",
        style_body
    ))
    items.append(Spacer(1, 0.2*cm))
    items += code_block("""CLIENT (Browser) — Next.js 14 App Router (SSR/CSR)
         |
         | HTTPS
         v
Next.js Server (API Routes / Server Actions)
  └── Auth.js (Session / JWT)
  └── Middleware (tenant isolation par companyId)
         |
         v
Prisma ORM → PostgreSQL
  └── Isolation par companyId sur chaque table""")

    items.append(PageBreak())
    return items

# ─── Section 3 : Structure des Dossiers ─────────────────────────────────────
def build_section_structure():
    items = []
    items += section_title("3. Structure des Dossiers")

    structure = """planificator/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   ├── reset-password/page.tsx
│   │   │   └── invite/[token]/page.tsx
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx              ← sidebar, navbar
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── planning/
│   │   │   │   ├── page.tsx            ← vue globale
│   │   │   │   ├── equipe/[id]/page.tsx
│   │   │   │   └── employe/[id]/page.tsx
│   │   │   ├── equipes/
│   │   │   ├── employes/
│   │   │   ├── chantiers/
│   │   │   ├── clients/
│   │   │   └── parametres/page.tsx
│   │   ├── (super-admin)/
│   │   │   └── entreprises/
│   │   ├── (client-portal)/
│   │   │   └── mes-chantiers/page.tsx
│   │   └── api/
│   │       ├── auth/[...nextauth]/route.ts
│   │       ├── invitations/route.ts
│   │       ├── equipes/route.ts
│   │       ├── employes/route.ts
│   │       ├── chantiers/route.ts
│   │       ├── affectations/route.ts
│   │       └── planning/route.ts
│   ├── components/
│   │   ├── ui/                         ← shadcn auto-générés
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   └── Navbar.tsx
│   │   ├── planning/
│   │   │   ├── PlanningCalendar.tsx
│   │   │   ├── PlanningEquipe.tsx
│   │   │   └── PlanningEmploye.tsx
│   │   ├── chantiers/
│   │   └── shared/
│   ├── lib/
│   │   ├── prisma.ts
│   │   ├── auth.ts
│   │   ├── mail.ts
│   │   └── validations/
│   ├── hooks/
│   ├── types/
│   └── middleware.ts
├── .env.local
├── next.config.ts
└── package.json"""

    items += code_block(structure)
    items.append(PageBreak())
    return items

# ─── Section 4 : Schéma Prisma ───────────────────────────────────────────────
def build_section_prisma():
    items = []
    items += section_title("4. Schéma Prisma Complet")

    # Enums
    items += subsection("4.1 Enums")
    items += code_block("""enum Role {
  SUPER_ADMIN    // Accès total, gère les entreprises
  ADMIN          // Gère son entreprise
  TEAM_LEADER    // Chef d'équipe, confirme/refuse
  EMPLOYEE       // Consulte son planning
  CLIENT         // Consulte ses chantiers uniquement
}

enum WorksiteStatus {
  PLANNED      // Planifié, pas encore commencé
  IN_PROGRESS  // En cours
  COMPLETED    // Terminé (archivage auto 48h après)
  ARCHIVED     // Archivé définitivement
  EXTENDED     // Prolongé
}

enum AssignmentStatus {
  PENDING    // En attente de confirmation
  CONFIRMED  // Confirmé par le chef d'équipe
  REFUSED    // Refusé avec raison
}

enum DocumentType {
  PLAN
  PHOTO
  DOCUMENT
}

enum HistoryAction {
  CREATED | UPDATED | DELETED | ASSIGNED | UNASSIGNED
  CONFIRMED | REFUSED | EXTENDED | ARCHIVED | INVITED | STATUS_CHANGED
}""")

    # Company
    items += subsection("4.2 Company (Tenant)")
    items += code_block("""model Company {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique  // pour sous-domaine futur
  logoUrl   String?
  address   String?
  phone     String?
  email     String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  users       User[]
  teams       Team[]
  clients     Client[]
  worksites   Worksite[]
  invitations Invitation[]

  @@map("companies")
}""")

    # User
    items += subsection("4.3 User")
    items += code_block("""model User {
  id          String    @id @default(cuid())
  email       String    @unique
  password    String
  firstName   String
  lastName    String
  phone       String?
  avatarUrl   String?
  role        Role      @default(EMPLOYEE)
  active      Boolean   @default(true)
  companyId   String?   // null uniquement pour SUPER_ADMIN
  lastLoginAt DateTime?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  // Relations
  company             Company?             @relation(fields: [companyId], references: [id], onDelete: SetNull)
  teamMemberships     TeamMember[]
  ledTeams            Team[]               @relation("TeamLeader")
  createdWorksites    Worksite[]           @relation("WorksiteCreatedBy")
  employeeAssignments EmployeeAssignment[]
  historyLogs         HistoryLog[]         @relation("HistoryActor")
  sentInvitations     Invitation[]         @relation("InvitedBy")
  clientProfile       ClientProfile?
  passwordResets      PasswordReset[]

  @@map("users")
}""")

    # Team + TeamMember
    items += subsection("4.4 Team &amp; TeamMember")
    items += code_block("""model Team {
  id        String   @id @default(cuid())
  name      String
  color     String?  // couleur hex pour le calendrier (#FF5733)
  companyId String
  leaderId  String
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  company     Company      @relation(fields: [companyId], references: [id], onDelete: Cascade)
  leader      User         @relation("TeamLeader", fields: [leaderId], references: [id])
  members     TeamMember[]
  assignments Assignment[]

  @@unique([name, companyId])  // pas de doublon dans la même entreprise
  @@map("teams")
}

model TeamMember {
  id       String    @id @default(cuid())
  teamId   String
  userId   String
  joinedAt DateTime  @default(now())
  leftAt   DateTime? // null = membre actif, sinon date de départ

  // Relations
  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
  @@map("team_members")
}""")

    items.append(PageBreak())

    # Client + ClientProfile
    items += subsection("4.5 Client &amp; ClientProfile")
    items += code_block("""model Client {
  id        String   @id @default(cuid())
  name      String
  email     String?
  phone     String?
  address   String?
  notes     String?
  companyId String
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  company       Company        @relation(fields: [companyId], references: [id], onDelete: Cascade)
  worksites     Worksite[]
  clientProfile ClientProfile?

  @@map("clients")
}

// Lien entre un Client et son compte User (accès portail)
model ClientProfile {
  id       String @id @default(cuid())
  clientId String @unique
  userId   String @unique

  // Relations
  client Client @relation(fields: [clientId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("client_profiles")
}""")

    # Worksite
    items += subsection("4.6 Worksite (Chantier)")
    items += code_block("""model Worksite {
  id          String         @id @default(cuid())
  name        String
  description String?
  address     String?
  latitude    Float?         // pour carte future
  longitude   Float?
  status      WorksiteStatus @default(PLANNED)
  startDate   DateTime
  endDate     DateTime
  dailyHours  Float          @default(10)  // heures/jour
  clientId    String
  companyId   String
  createdById String
  archivedAt  DateTime?
  completedAt DateTime?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt

  // Relations
  client      Client       @relation(fields: [clientId], references: [id])
  company     Company      @relation(fields: [companyId], references: [id], onDelete: Cascade)
  createdBy   User         @relation("WorksiteCreatedBy", fields: [createdById], references: [id])
  documents   Document[]
  assignments Assignment[]
  extensions  Extension[]
  historyLogs HistoryLog[]

  @@map("worksites")
}""")

    items.append(PageBreak())

    # Document
    items += subsection("4.7 Document")
    items += code_block("""model Document {
  id         String       @id @default(cuid())
  worksiteId String
  name       String
  url        String
  size       Int?         // taille en octets
  mimeType   String?
  type       DocumentType @default(DOCUMENT)
  uploadedAt DateTime     @default(now())

  // Relations
  worksite Worksite @relation(fields: [worksiteId], references: [id], onDelete: Cascade)

  @@map("documents")
}""")

    # Assignment
    items += subsection("4.8 Assignment &amp; EmployeeAssignment (Planning)")
    items += code_block("""model Assignment {
  id            String           @id @default(cuid())
  worksiteId    String
  teamId        String
  date          DateTime         @db.Date  // journée complète
  status        AssignmentStatus @default(PENDING)
  refusalReason String?
  notes         String?
  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  // Relations
  worksite            Worksite             @relation(fields: [worksiteId], references: [id], onDelete: Cascade)
  team                Team                 @relation(fields: [teamId], references: [id])
  employeeAssignments EmployeeAssignment[]

  @@unique([teamId, date])  // CONTRAINTE CLE : 1 équipe = 1 chantier/jour max
  @@map("assignments")
}

model EmployeeAssignment {
  id           String   @id @default(cuid())
  assignmentId String
  userId       String
  date         DateTime @db.Date  // dupliqué pour la contrainte unique
  createdAt    DateTime @default(now())

  // Relations
  assignment Assignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  user       User       @relation(fields: [userId], references: [id])

  @@unique([userId, date])  // CONTRAINTE CLE : 1 employé = 1 chantier/jour max
  @@map("employee_assignments")
}""")

    # Extension
    items += subsection("4.9 Extension (Prolongation chantier)")
    items += code_block("""model Extension {
  id              String   @id @default(cuid())
  worksiteId      String
  previousEndDate DateTime
  newEndDate      DateTime
  reason          String?
  createdAt       DateTime @default(now())

  // Relations
  worksite Worksite @relation(fields: [worksiteId], references: [id], onDelete: Cascade)

  @@map("extensions")
}""")

    # HistoryLog
    items += subsection("4.10 HistoryLog (Audit Trail)")
    items += code_block("""model HistoryLog {
  id         String        @id @default(cuid())
  worksiteId String?
  actorId    String        // qui a effectué l'action
  action     HistoryAction
  entityType String?       // "Worksite" | "Team" | "Assignment" | ...
  entityId   String?       // id de l'entité modifiée
  detail     String?       // description lisible
  metadata   Json?         // données avant/après (diff complet)
  createdAt  DateTime      @default(now())

  // Relations
  worksite Worksite? @relation(fields: [worksiteId], references: [id], onDelete: SetNull)
  actor    User      @relation("HistoryActor", fields: [actorId], references: [id])

  @@map("history_logs")
}""")

    # Invitation + PasswordReset
    items += subsection("4.11 Invitation &amp; PasswordReset")
    items += code_block("""model Invitation {
  id          String    @id @default(cuid())
  email       String
  role        Role
  companyId   String
  invitedById String
  token       String    @unique @default(cuid())
  expiresAt   DateTime  // recommandé : 24h
  usedAt      DateTime?
  createdAt   DateTime  @default(now())

  // Relations
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  invitedBy User    @relation("InvitedBy", fields: [invitedById], references: [id])

  @@map("invitations")
}

model PasswordReset {
  id        String    @id @default(cuid())
  userId    String
  token     String    @unique @default(cuid())
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime  @default(now())

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("password_resets")
}""")
    items.append(PageBreak())
    return items

# ─── Section 5 : Relations ───────────────────────────────────────────────────
def build_section_relations():
    items = []
    items += section_title("5. Diagramme des Relations")

    items += code_block("""Company (tenant)
  ├── User[]
  │     ├── companyId ──────────────────────────► Company
  │     ├── TeamMember[] ─────────────────────► Team (membre)
  │     ├── Team[] (leaderId) ◄────────────────── "TeamLeader"
  │     ├── Worksite[] (createdById)
  │     ├── EmployeeAssignment[]
  │     ├── HistoryLog[] (actorId)
  │     ├── Invitation[] (invitedById)
  │     ├── ClientProfile? ──────────────────► Client
  │     └── PasswordReset[]
  │
  ├── Team[]
  │     ├── companyId ──────────────────────► Company
  │     ├── leaderId ────────────────────────► User
  │     ├── TeamMember[] ───────────────────► User
  │     └── Assignment[]
  │           ├── worksiteId ──────────────► Worksite
  │           ├── teamId ──────────────────► Team
  │           └── EmployeeAssignment[]
  │                 ├── assignmentId ──────► Assignment
  │                 └── userId ────────────► User
  │
  ├── Client[]
  │     ├── companyId ──────────────────────► Company
  │     ├── Worksite[]
  │     └── ClientProfile? ─────────────────► User
  │
  └── Worksite[]
        ├── companyId ──────────────────────► Company
        ├── clientId ────────────────────────► Client
        ├── createdById ────────────────────► User
        ├── Document[]
        ├── Assignment[]
        ├── Extension[]
        └── HistoryLog[]""")

    items.append(Spacer(1, 0.4*cm))
    items += subsection("Cardinalités")
    card_data = [
        ["Relation", "Type", "Description"],
        ["Company → User",          "1 → N", "Une entreprise a plusieurs utilisateurs"],
        ["Company → Team",          "1 → N", "Une entreprise a plusieurs équipes"],
        ["Company → Client",        "1 → N", "Une entreprise a plusieurs clients"],
        ["Company → Worksite",      "1 → N", "Une entreprise a plusieurs chantiers"],
        ["Team → User (leader)",    "N → 1", "Chaque équipe a exactement un chef"],
        ["Team ↔ User (members)",   "N ↔ N", "Via TeamMember (avec date joinedAt/leftAt)"],
        ["Client → Worksite",       "1 → N", "Un client peut avoir plusieurs chantiers"],
        ["Worksite → Assignment",   "1 → N", "Un chantier peut avoir plusieurs affectations"],
        ["Team → Assignment",       "1 → N", "Unique par jour (contrainte @@unique)"],
        ["User → EmployeeAssignment","1 → N","Unique par jour (contrainte @@unique)"],
        ["Worksite → Document",     "1 → N", "Plusieurs fichiers par chantier"],
        ["Worksite → Extension",    "1 → N", "Historique des prolongations"],
        ["Client ↔ User",           "1 ↔ 1", "Via ClientProfile (portail client)"],
    ]
    card_t = Table(card_data, colWidths=[5.5*cm, 2.5*cm, 9*cm])
    card_t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PRIMARY),
        ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTNAME",   (0,1), (0,-1), "Helvetica-Bold"),
        ("TEXTCOLOR",  (0,1), (0,-1), PRIMARY),
        ("FONTSIZE",   (0,0), (-1,-1), 8),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 7),
        ("GRID", (0,0), (-1,-1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f0f9ff")]),
        ("ALIGN", (1,0), (1,-1), "CENTER"),
        ("TEXTCOLOR", (1,1), (1,-1), colors.HexColor("#7c3aed")),
        ("FONTNAME", (1,1), (1,-1), "Helvetica-Bold"),
    ]))
    items.append(card_t)
    items.append(PageBreak())
    return items

# ─── Section 6 : Rôles ───────────────────────────────────────────────────────
def build_section_roles():
    items = []
    items += section_title("6. Matrice des Rôles &amp; Permissions")

    check = "✓"
    cross = "✗"
    partial = "~"

    role_data = [
        ["Fonctionnalité", "Super\nAdmin", "Admin", "Chef\nEquipe", "Employé", "Client"],
        ["Gérer les entreprises",          check, cross, cross, cross, cross],
        ["Inviter des utilisateurs",       check, check, cross, cross, cross],
        ["Gérer les équipes",              check, check, cross, cross, cross],
        ["Gérer les chantiers",            check, check, cross, cross, cross],
        ["Gérer les clients",              check, check, cross, cross, cross],
        ["Voir planning global",           check, check, cross, cross, cross],
        ["Voir planning de son équipe",    check, check, check, cross, cross],
        ["Voir son propre planning",       check, check, check, check, cross],
        ["Confirmer/refuser affectation",  check, check, check, cross, cross],
        ["Prolonger un chantier",          check, check, cross, cross, cross],
        ["Voir ses propres chantiers",     cross, cross, cross, cross, check],
        ["Voir planning lié ses chantiers",cross, cross, cross, cross, check],
        ["Voir documents chantier",        check, check, check, check, check],
    ]

    col_widths = [6.5*cm, 1.8*cm, 1.8*cm, 2*cm, 1.9*cm, 1.8*cm]
    role_t = Table(role_data, colWidths=col_widths)

    ts = TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PRIMARY),
        ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 8.5),
        ("ALIGN",      (1,0), (-1,-1), "CENTER"),
        ("VALIGN",     (0,0), (-1,-1), "MIDDLE"),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (0,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f8fafc")]),
    ])
    # Color check/cross cells
    for row_idx in range(1, len(role_data)):
        for col_idx in range(1, 6):
            val = role_data[row_idx][col_idx]
            if val == check:
                ts.add("TEXTCOLOR", (col_idx, row_idx), (col_idx, row_idx), GREEN)
                ts.add("FONTNAME",  (col_idx, row_idx), (col_idx, row_idx), "Helvetica-Bold")
            elif val == cross:
                ts.add("TEXTCOLOR", (col_idx, row_idx), (col_idx, row_idx), colors.HexColor("#ef4444"))
            elif val == partial:
                ts.add("TEXTCOLOR", (col_idx, row_idx), (col_idx, row_idx), ORANGE)
                ts.add("FONTNAME",  (col_idx, row_idx), (col_idx, row_idx), "Helvetica-Bold")

    role_t.setStyle(ts)
    items.append(role_t)
    items.append(PageBreak())
    return items

# ─── Section 7 : Routes API ──────────────────────────────────────────────────
def build_section_api():
    items = []
    items += section_title("7. Routes API Principales")

    api_groups = [
        ("Authentification", [
            ("POST", "/api/auth/[...nextauth]", "Login, logout, session"),
            ("POST", "/api/auth/reset-password", "Demander un reset"),
            ("PUT",  "/api/auth/reset-password/[token]", "Valider le nouveau mot de passe"),
        ]),
        ("Invitations", [
            ("POST", "/api/invitations", "Inviter un utilisateur"),
            ("GET",  "/api/invitations/[token]", "Valider le token"),
            ("POST", "/api/invitations/[token]", "Créer le compte depuis invitation"),
        ]),
        ("Entreprises (Super Admin)", [
            ("GET",    "/api/companies", "Lister toutes les entreprises"),
            ("POST",   "/api/companies", "Créer une entreprise"),
            ("GET",    "/api/companies/[id]", "Détail entreprise"),
            ("PUT",    "/api/companies/[id]", "Modifier entreprise"),
            ("DELETE", "/api/companies/[id]", "Désactiver entreprise"),
        ]),
        ("Équipes", [
            ("GET",    "/api/teams", "Lister (filtrées par companyId)"),
            ("POST",   "/api/teams", "Créer une équipe"),
            ("PUT",    "/api/teams/[id]", "Modifier équipe / changer chef"),
            ("DELETE", "/api/teams/[id]", "Archiver équipe"),
            ("POST",   "/api/teams/[id]/members", "Ajouter un membre"),
            ("DELETE", "/api/teams/[id]/members/[userId]", "Retirer un membre"),
        ]),
        ("Employés", [
            ("GET",  "/api/employees", "Lister les employés"),
            ("POST", "/api/employees", "Créer un employé"),
            ("PUT",  "/api/employees/[id]", "Modifier employé"),
            ("GET",  "/api/employees/[id]/planning", "Planning d'un employé"),
        ]),
        ("Clients", [
            ("GET",  "/api/clients", "Lister les clients"),
            ("POST", "/api/clients", "Créer un client"),
            ("PUT",  "/api/clients/[id]", "Modifier client"),
        ]),
        ("Chantiers", [
            ("GET",    "/api/worksites", "Lister les chantiers"),
            ("POST",   "/api/worksites", "Créer un chantier"),
            ("GET",    "/api/worksites/[id]", "Détail chantier"),
            ("PUT",    "/api/worksites/[id]", "Modifier chantier"),
            ("POST",   "/api/worksites/[id]/extend", "Prolonger un chantier"),
            ("POST",   "/api/worksites/[id]/archive", "Archiver manuellement"),
            ("POST",   "/api/worksites/[id]/documents", "Uploader un document"),
        ]),
        ("Affectations (Planning)", [
            ("GET",    "/api/assignments", "?from=&to=&teamId=&employeeId="),
            ("POST",   "/api/assignments", "Affecter une équipe à un chantier"),
            ("PUT",    "/api/assignments/[id]/status", "Confirmer ou refuser"),
            ("DELETE", "/api/assignments/[id]", "Supprimer une affectation"),
        ]),
    ]

    method_colors = {
        "GET":    colors.HexColor("#0ea5e9"),
        "POST":   colors.HexColor("#10b981"),
        "PUT":    colors.HexColor("#f59e0b"),
        "DELETE": colors.HexColor("#ef4444"),
    }

    for group_name, routes in api_groups:
        items += subsection(group_name)
        data = [["Méthode", "Route", "Description"]]
        for method, route, desc in routes:
            data.append([method, route, desc])
        t = Table(data, colWidths=[2*cm, 8*cm, 7*cm])
        ts = TableStyle([
            ("BACKGROUND", (0,0), (-1,0), ACCENT),
            ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
            ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
            ("FONTSIZE",   (0,0), (-1,-1), 8),
            ("TOPPADDING", (0,0), (-1,-1), 4),
            ("BOTTOMPADDING", (0,0), (-1,-1), 4),
            ("LEFTPADDING", (0,0), (-1,-1), 6),
            ("GRID", (0,0), (-1,-1), 0.4, BORDER),
            ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f8fafc")]),
            ("ALIGN", (0,0), (0,-1), "CENTER"),
            ("FONTNAME", (1,1), (1,-1), "Courier"),
        ])
        for i, (method, _, _) in enumerate(routes, 1):
            ts.add("TEXTCOLOR", (0, i), (0, i), method_colors.get(method, GRAY))
            ts.add("FONTNAME", (0, i), (0, i), "Helvetica-Bold")
        t.setStyle(ts)
        items.append(t)
        items.append(Spacer(1, 0.3*cm))

    items.append(PageBreak())
    return items

# ─── Section 8 : Plan de Développement ──────────────────────────────────────
def build_section_plan():
    items = []
    items += section_title("8. Plan de Développement — 8 Étapes")

    steps = [
        ("Étape 1", "Setup & Infrastructure", "2-3h",
         ["Init Next.js + TypeScript", "Prisma + PostgreSQL + migrations",
          "shadcn/ui + Tailwind configuration", "Variables d'environnement"]),
        ("Étape 2", "Authentification", "3-4h",
         ["NextAuth v5 (email/password)", "Login page", "Reset mot de passe",
          "Invitation par email (Resend)", "Middleware de protection des routes"]),
        ("Étape 3", "Multi-tenant & Rôles", "2-3h",
         ["Middleware Prisma (tenant filter automatique)",
          "Hook useCurrentUser", "Composant RoleGate"]),
        ("Étape 4", "Gestion Admin", "4-5h",
         ["Dashboard avec statistiques", "CRUD Entreprises (Super Admin)",
          "CRUD Employés", "CRUD Équipes + assignation chef d'équipe"]),
        ("Étape 5", "Chantiers", "4-5h",
         ["CRUD Chantiers", "CRUD Clients", "Upload documents/plans/photos",
          "Archivage automatique (cron job)"]),
        ("Étape 6", "Planning & Affectations", "5-6h",
         ["Calendrier react-big-calendar", "Affectation équipe ↔ chantier",
          "Contraintes : 1 chantier/équipe/jour", "Confirmation / refus avec raison",
          "Vues : globale, équipe, employé"]),
        ("Étape 7", "Portail Client", "2-3h",
         ["Vue client (ses chantiers uniquement)",
          "Planning lié à ses chantiers"]),
        ("Étape 8", "Finitions V1", "2-3h",
         ["Historique des modifications (audit trail)", "Fonction prolonger chantier",
          "Archivage auto 48h post-complétion", "Tests manuels + seed"]),
    ]
    bg_colors = [
        colors.HexColor("#eff6ff"),
        colors.HexColor("#f0fdf4"),
        colors.HexColor("#fefce8"),
        colors.HexColor("#fdf4ff"),
        colors.HexColor("#fff7ed"),
        colors.HexColor("#ecfdf5"),
        colors.HexColor("#f0f9ff"),
        colors.HexColor("#fef2f2"),
    ]
    accent_colors = [
        colors.HexColor("#3b82f6"),
        colors.HexColor("#10b981"),
        colors.HexColor("#f59e0b"),
        colors.HexColor("#a855f7"),
        colors.HexColor("#f97316"),
        colors.HexColor("#06b6d4"),
        colors.HexColor("#0ea5e9"),
        colors.HexColor("#ef4444"),
    ]

    for i, (step, title, duration, tasks) in enumerate(steps):
        tasks_text = "<br/>".join([f"&#8226; {t}" for t in tasks])
        row_data = [[
            Paragraph(f"<b>{step}</b>", ParagraphStyle("sn", fontSize=9, textColor=WHITE,
                       fontName="Helvetica-Bold", alignment=TA_CENTER)),
            Paragraph(f"<b>{title}</b><br/><font size='7' color='#6b7280'>{duration}</font>",
                       ParagraphStyle("st", fontSize=9.5, textColor=DARK, fontName="Helvetica-Bold", leading=13)),
            Paragraph(tasks_text, ParagraphStyle("stask", fontSize=8.5, textColor=colors.HexColor("#374151"),
                       fontName="Helvetica", leading=13)),
        ]]
        t = Table(row_data, colWidths=[2*cm, 4.5*cm, 10.5*cm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0,0), (0,0), accent_colors[i]),
            ("BACKGROUND", (1,0), (-1,0), bg_colors[i]),
            ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
            ("TOPPADDING", (0,0), (-1,-1), 8),
            ("BOTTOMPADDING", (0,0), (-1,-1), 8),
            ("LEFTPADDING", (0,0), (0,0), 6),
            ("LEFTPADDING", (1,0), (-1,-1), 8),
            ("GRID", (0,0), (-1,-1), 0.5, BORDER),
        ]))
        items.append(t)
        items.append(Spacer(1, 0.15*cm))

    items.append(PageBreak())
    return items

# ─── Section 9 : Points de Vigilance ─────────────────────────────────────────
def build_section_warnings():
    items = []
    items += section_title("9. Points de Vigilance")

    warnings = [
        ("Securité", [
            "Toujours valider companyId côté serveur — ne jamais le prendre depuis le client",
            "Le middleware Prisma doit filtrer CHAQUE requête par companyId",
            "Les tokens d'invitation expirent après 24h maximum",
            "Hasher les mots de passe avec bcrypt (minimum 12 rounds)",
            "Rate limiting sur les endpoints d'authentification",
        ]),
        ("Contraintes Métier BDD", [
            "@@unique([teamId, date]) sur Assignment est le filet de sécurité côté BDD — obligatoire",
            "@@unique([userId, date]) sur EmployeeAssignment — idem",
            "@db.Date sur date stocke uniquement la date sans heure — évite les conflits UTC",
            "Stocker toutes les dates en UTC, afficher en fuseau local côté client",
        ]),
        ("Architecture Next.js 14", [
            "NextAuth v5 (beta) a une API différente de v4 — suivre auth.js.dev",
            "Utiliser les Server Actions pour les mutations (moins de boilerplate que les routes API)",
            "Garder les composants clients ('use client') au minimum — privilégier Server Components",
        ]),
        ("Scalabilité Future", [
            "Le slug sur Company prépare le déploiement multi-sous-domaines",
            "Le schéma par colonne permet une migration vers des schémas séparés si besoin",
            "Prévoir une table Plan/Subscription pour la commercialisation",
            "Ne pas over-engineer la V1 — YAGNI",
        ]),
    ]

    warn_icons = ["", "", "", ""]
    warn_colors = [
        colors.HexColor("#fef2f2"),
        colors.HexColor("#fefce8"),
        colors.HexColor("#eff6ff"),
        colors.HexColor("#f0fdf4"),
    ]
    warn_borders = [
        colors.HexColor("#ef4444"),
        colors.HexColor("#f59e0b"),
        colors.HexColor("#3b82f6"),
        colors.HexColor("#10b981"),
    ]

    for i, (category, points) in enumerate(warnings):
        items += subsection(f"{warn_icons[i]} {category}")
        for p in points:
            items.append(bullet(p))
        items.append(Spacer(1, 0.2*cm))

    items.append(PageBreak())
    return items

# ─── Section 10 : Commandes ───────────────────────────────────────────────────
def build_section_commands():
    items = []
    items += section_title("10. Commandes d'Installation")

    items += code_block("""# 1. Créer le projet Next.js
npx create-next-app@latest planificator \\
  --typescript --tailwind --eslint \\
  --app --src-dir --import-alias "@/*"

cd planificator

# 2. ORM & Base de données
npm install prisma @prisma/client
npx prisma init

# 3. Authentification
npm install next-auth@beta @auth/prisma-adapter

# 4. Validation
npm install zod

# 5. Email (invitations + reset password)
npm install resend

# 6. Upload fichiers
npm install uploadthing @uploadthing/react

# 7. Planning calendrier
npm install react-big-calendar date-fns
npm install -D @types/react-big-calendar

# 8. shadcn/ui
npx shadcn@latest init
npx shadcn@latest add button input label card dialog table badge
npx shadcn@latest add select textarea avatar dropdown-menu
npx shadcn@latest add calendar popover sheet tabs

# 9. Utilitaires
npm install clsx tailwind-merge bcryptjs
npm install -D @types/bcryptjs

# 10. Première migration
npx prisma migrate dev --name init
npx prisma generate

# 11. Lancer l'application
npm run dev""")

    items.append(Spacer(1, 0.4*cm))
    items += subsection("Variables d'Environnement (.env.local)")
    items += code_block("""# Base de données
DATABASE_URL="postgresql://user:password@localhost:5432/planificator"

# NextAuth
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-key-here"

# Email (Resend)
RESEND_API_KEY="re_xxxxxxxxxxxx"
EMAIL_FROM="Planificator <noreply@planificator.fr>"

# Upload (UploadThing)
UPLOADTHING_SECRET="sk_live_xxxxxxxxxxxx"
UPLOADTHING_APP_ID="xxxxxxxxxxxx"

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
INVITATION_EXPIRY_HOURS=24""")

    items.append(PageBreak())
    return items

# ─── Page de conclusion ───────────────────────────────────────────────────────
def build_conclusion():
    items = []
    items += section_title("Prochaines Étapes")

    items.append(Paragraph(
        "Ce document valide l'architecture complète de Planificator V1. "
        "Une fois ce document approuvé, le développement peut commencer par l'Étape 1.",
        style_body
    ))
    items.append(Spacer(1, 0.4*cm))

    next_steps = [
        ("1", "Valider ce document d'architecture", "Admin"),
        ("2", "Créer le repository Git (GitHub/GitLab)", "Admin"),
        ("3", "Configurer PostgreSQL local", "Dev"),
        ("4", "Exécuter les commandes d'installation (Section 10)", "Dev"),
        ("5", "Copier le schéma Prisma (Section 4) dans prisma/schema.prisma", "Dev"),
        ("6", "Lancer npx prisma migrate dev --name init", "Dev"),
        ("7", "Démarrer l'Étape 2 : Authentification", "Dev"),
    ]

    ns_data = [["#", "Action", "Rôle"]] + next_steps
    ns_t = Table(ns_data, colWidths=[1*cm, 13*cm, 3*cm])
    ns_t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PRIMARY),
        ("TEXTCOLOR",  (0,0), (-1,0), WHITE),
        ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",   (0,0), (-1,-1), 9),
        ("TOPPADDING", (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING", (0,0), (-1,-1), 8),
        ("GRID", (0,0), (-1,-1), 0.4, BORDER),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, colors.HexColor("#f0f9ff")]),
        ("ALIGN", (0,0), (0,-1), "CENTER"),
        ("TEXTCOLOR", (0,1), (0,-1), PRIMARY),
        ("FONTNAME", (0,1), (0,-1), "Helvetica-Bold"),
        ("FONTNAME", (2,1), (2,-1), "Helvetica-Bold"),
        ("TEXTCOLOR", (2,1), (2,-1), colors.HexColor("#7c3aed")),
    ]))
    items.append(ns_t)
    items.append(Spacer(1, 0.8*cm))
    items.append(hr(PRIMARY, 1))
    items.append(Spacer(1, 0.3*cm))
    items.append(Paragraph(
        f"Document généré le {datetime.date.today().strftime('%d/%m/%Y')} — Planificator V1.0",
        ParagraphStyle("footer", fontSize=8, textColor=GRAY, alignment=TA_CENTER, fontName="Helvetica-Oblique")
    ))
    return items

# ─── Assemblage ──────────────────────────────────────────────────────────────
story = []
story += build_cover()
story += build_section_context()
story += build_section_architecture()
story += build_section_structure()
story += build_section_prisma()
story += build_section_relations()
story += build_section_roles()
story += build_section_api()
story += build_section_plan()
story += build_section_warnings()
story += build_section_commands()
story += build_conclusion()

# ─── Build ───────────────────────────────────────────────────────────────────
def add_page_number(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(GRAY)
    page_num = canvas.getPageNumber()
    canvas.drawRightString(A4[0] - 2*cm, 1.2*cm, f"Page {page_num}")
    canvas.drawString(2*cm, 1.2*cm, "Planificator — Architecture V1.0 — Confidentiel")
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.5)
    canvas.line(2*cm, 1.5*cm, A4[0] - 2*cm, 1.5*cm)
    canvas.restoreState()

doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)
print(f"PDF généré : {OUTPUT_PATH}")
