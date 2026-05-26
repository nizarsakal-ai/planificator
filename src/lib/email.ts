import { Resend } from "resend"

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM = process.env.FROM_EMAIL ?? "Planificator <noreply@planificator.fr>"
const APP_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000"

// ─── Invitation ───────────────────────────────────────────────────────────────

export async function sendInvitationEmail({
  to,
  token,
  companyName,
  invitedByName,
  role,
}: {
  to: string
  token: string
  companyName: string
  invitedByName: string
  role: string
}) {
  const url = `${APP_URL}/invitation?token=${token}`

  const roleLabels: Record<string, string> = {
    ADMIN:       "Administrateur",
    TEAM_LEADER: "Chef d'équipe",
    EMPLOYEE:    "Employé",
  }

  await resend.emails.send({
    from: FROM,
    to,
    subject: `Invitation à rejoindre ${companyName} sur Planificator`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 32px;">
        <div style="background: #0f3460; color: white; padding: 24px; border-radius: 12px; text-align: center; margin-bottom: 32px;">
          <h1 style="margin: 0; font-size: 24px;">Planificator</h1>
          <p style="margin: 8px 0 0; opacity: 0.8; font-size: 14px;">Planning d'équipes</p>
        </div>

        <h2 style="color: #1e293b; margin-bottom: 8px;">Vous êtes invité !</h2>
        <p style="color: #64748b; line-height: 1.6;">
          <strong>${invitedByName}</strong> vous invite à rejoindre <strong>${companyName}</strong>
          en tant que <strong>${roleLabels[role] ?? role}</strong>.
        </p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${url}"
             style="background: #0f3460; color: white; padding: 14px 32px; border-radius: 8px;
                    text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
            Accepter l'invitation
          </a>
        </div>

        <p style="color: #94a3b8; font-size: 12px; text-align: center;">
          Ce lien est valable 7 jours. Si vous n'attendiez pas cette invitation, ignorez cet email.
        </p>
      </div>
    `,
  })
}

// ─── Réinitialisation mot de passe ───────────────────────────────────────────

export async function sendPasswordResetEmail({
  to,
  token,
}: {
  to: string
  token: string
}) {
  const url = `${APP_URL}/reinitialiser?token=${token}`

  await resend.emails.send({
    from: FROM,
    to,
    subject: "Réinitialisation de votre mot de passe Planificator",
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 32px;">
        <div style="background: #0f3460; color: white; padding: 24px; border-radius: 12px; text-align: center; margin-bottom: 32px;">
          <h1 style="margin: 0; font-size: 24px;">Planificator</h1>
        </div>

        <h2 style="color: #1e293b; margin-bottom: 8px;">Réinitialisation du mot de passe</h2>
        <p style="color: #64748b; line-height: 1.6;">
          Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous.
        </p>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${url}"
             style="background: #0f3460; color: white; padding: 14px 32px; border-radius: 8px;
                    text-decoration: none; font-weight: 600; font-size: 15px; display: inline-block;">
            Réinitialiser mon mot de passe
          </a>
        </div>

        <p style="color: #94a3b8; font-size: 12px; text-align: center;">
          Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet email.
        </p>
      </div>
    `,
  })
}
