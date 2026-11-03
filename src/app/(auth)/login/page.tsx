import type { Metadata } from "next"
import { LoginExperience } from "@/components/auth/LoginExperience"

export const metadata: Metadata = {
  title: "Connexion",
}

export default function LoginPage() {
  return <LoginExperience />
}
