import { build } from "esbuild"
import path from "node:path"
const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, "../../..")
const alias = {
  "@/lib/actions/client.actions": path.join(here, "stubs.tsx"),
  "@/lib/actions/chantier.actions": path.join(here, "stubs.tsx"),
  "next/navigation": path.join(here, "next-navigation.ts"),
}
await build({
  entryPoints: [path.join(here, "entry.tsx")],
  bundle: true, outfile: process.argv[2], format: "iife", jsx: "automatic",
  tsconfig: path.join(root, "tsconfig.json"), absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "stubs", setup(b) {
    b.onResolve({ filter: /^(@\/lib\/actions\/(client|chantier)\.actions|next\/navigation)$/ }, (a) => ({ path: alias[a.path] }))
  } }],
  logLevel: "warning",
})
