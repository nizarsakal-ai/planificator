import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "fr.planificator.app",
  appName: "Planificator",
  // En production : pointer vers l'URL déployée
  // En dev local : pointer vers le serveur Next.js
  server: {
    url: "https://planificator.vercel.app", // ← remplacer par l'URL de prod
    cleartext: false,
  },
  ios: {
    contentInset: "always",
    backgroundColor: "#0f3460",
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#0f3460",
      androidSplashResourceName: "splash",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
  },
}

export default config
