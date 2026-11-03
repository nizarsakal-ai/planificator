/**
 * Connexion « bleu nuit éditorial » — rendu statique (doubles de next/navigation, next-auth/react et next/font) et
 * garde-fous de source : logique de connexion inchangée, décor sans élément interactif.
 * Exécution : `node --import tsx --experimental-test-module-mocks --test tests/auth/login-experience.render.test.tsx`.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { before, describe, it, mock } from "node:test"
import React, { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

;(globalThis as { React?: typeof React }).React = React

type Component = (props: Record<string, unknown>) => React.ReactElement
let LoginExperience: Component

before(async () => {
  mock.module("next/navigation", { namedExports: { useRouter: () => ({ push: () => undefined, refresh: () => undefined }) } })
  mock.module("next-auth/react", { namedExports: { signIn: async () => ({ ok: false }) } })
  mock.module("next/font/google", { namedExports: { Instrument_Serif: () => ({ className: "font-serif-test" }) } })
  ;({ LoginExperience } = (await import("@/components/auth/LoginExperience")) as unknown as { LoginExperience: Component })
})

const read = (path: string) => readFileSync(path, "utf8")

describe("page de connexion", () => {
  it("formulaire, libellés, liens et ordre inchangés ; un seul h1", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    assert.match(html, /<label[^>]*for="email"[^>]*>Adresse email<\/label>/)
    assert.match(html, /<label[^>]*for="password"[^>]*>Mot de passe<\/label>/)
    assert.match(html, /<input[^>]*id="email"[^>]*type="email"|<input[^>]*type="email"[^>]*id="email"/)
    assert.match(html, /autocomplete="email"/i)
    assert.match(html, /autocomplete="current-password"/i)
    assert.match(html, /href="\/mot-de-passe-oublie"/)
    assert.match(html, /href="\/inscription"/)
    assert.match(html, /<button type="submit"[^>]*>Se connecter/)
  })
  it("« Mot de passe oublié ? » entre le mot de passe et le bouton (ordre de tabulation)", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    const order = ['id="password"', 'href="/mot-de-passe-oublie"', 'type="submit"', 'href="/inscription"'].map((m) => html.indexOf(m))
    assert.ok(order.every((at) => at >= 0), "tous présents")
    assert.deepEqual([...order].sort((a, b) => a - b), order)
  })
  it("bouton Afficher : natif, atteignable au clavier, libellé et état annoncés", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    const toggle = /<button type="button"[^>]*aria-controls="password"[^>]*>/.exec(html)?.[0] ?? ""
    assert.ok(toggle, "bouton présent")
    assert.match(toggle, /aria-pressed="false"/)
    assert.match(toggle, /aria-label="Afficher le mot de passe"/)
    assert.equal(/tabindex="-1"/i.test(toggle), false, "plus exclu de la tabulation")
  })
  it("grille décorative masquée des technologies d'assistance, sans élément interactif", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    const grid = /<div class="[^"]*grid-cols-\[repeat\(7,46px\)\][^"]*" aria-hidden="true">(.*?)<\/div>/.exec(html)
    assert.ok(grid, "grille présente et aria-hidden")
    assert.equal((grid[1].match(/<span\b/g) ?? []).length, 42)
    assert.equal(/<(input|a|button)\b/.test(grid[1]), false)
  })
  it("seule la carte du formulaire suit Apparence ; aucune animation", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    assert.equal((html.match(/data-appearance-scope=""/g) ?? []).length, 1)
    assert.match(html, /<section data-appearance-scope=""[^>]*>\s*<h1/)
    assert.doesNotMatch(read("src/components/auth/LoginExperience.tsx"), /animate-/)
  })
})

describe("garde-fous de source", () => {
  it("logique de connexion inchangée (schéma, signIn credentials sans redirection, messages, redirection /)", () => {
    const src = read("src/components/auth/LoginForm.tsx")
    for (const fragment of [
      `.min(1, "L'email est requis")`, `.email("Format d'email invalide")`, `z.string().min(1, "Le mot de passe est requis")`,
      `signIn("credentials", {`, `email: data.email,`, `password: data.password,`, `redirect: false,`,
      `setServerError("Email ou mot de passe incorrect.")`, `setServerError("Une erreur est survenue. Veuillez réessayer.")`,
      `router.push("/")`, `router.refresh()`,
    ]) assert.ok(src.includes(fragment), fragment)
  })
  it("la page ne lit ni ne stocke aucune saisie", () => {
    for (const path of ["src/components/auth/LoginExperience.tsx", "src/components/auth/LoginForm.tsx"]) {
      assert.doesNotMatch(read(path), /localStorage|sessionStorage|fetch\(/, path)
    }
  })
})
