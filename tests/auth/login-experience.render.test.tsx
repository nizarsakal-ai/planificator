/**
 * Connexion « deux tons » — rendu statique (doubles de next/navigation, next-auth/react et next/font) et garde-fous
 * de source : logique de connexion inchangée, illustration décorative qui ne reçoit jamais la valeur des champs.
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
let LoginCrew: Component

before(async () => {
  mock.module("next/navigation", { namedExports: { useRouter: () => ({ push: () => undefined, refresh: () => undefined }) } })
  mock.module("next-auth/react", { namedExports: { signIn: async () => ({ ok: false }) } })
  mock.module("next/font/google", { namedExports: { Instrument_Serif: () => ({ className: "font-serif-test" }) } })
  ;({ LoginExperience } = (await import("@/components/auth/LoginExperience")) as unknown as { LoginExperience: Component })
  ;({ LoginCrew } = (await import("@/components/auth/LoginCrew")) as unknown as { LoginCrew: Component })
})

const read = (path: string) => readFileSync(path, "utf8")

describe("page de connexion", () => {
  it("formulaire, libellés, liens et ordre inchangés ; un seul h1", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    assert.match(html, /<label[^>]*for="email"[^>]*>Adresse email<\/label>/)
    assert.match(html, /<label[^>]*for="password"[^>]*>Mot de passe<\/label>/)
    assert.match(html, /<input[^>]*id="email"[^>]*type="email"|<input[^>]*type="email"[^>]*id="email"/)
    assert.match(html, /autoComplete="email"|autocomplete="email"/)
    assert.match(html, /autocomplete="current-password"/i)
    assert.match(html, /href="\/mot-de-passe-oublie"/)
    assert.match(html, /href="\/inscription"/)
    assert.match(html, /<button type="submit"[^>]*>Se connecter/)
  })
  it("bouton Afficher : natif, atteignable au clavier, libellé et état annoncés", () => {
    const html = renderToStaticMarkup(createElement(LoginExperience))
    const toggle = /<button type="button"[^>]*aria-controls="password"[^>]*>/.exec(html)?.[0] ?? ""
    assert.ok(toggle, "bouton présent")
    assert.match(toggle, /aria-pressed="false"/)
    assert.match(toggle, /aria-label="Afficher le mot de passe"/)
    assert.equal(/tabindex="-1"/i.test(toggle), false, "plus exclu de la tabulation")
  })
  it("illustration décorative : masquée des technologies d'assistance, sans champ ni lien", () => {
    const html = renderToStaticMarkup(createElement(LoginCrew, { focusedField: null, passwordVisible: false }))
    assert.match(html, /^<svg[^>]*aria-hidden="true"/)
    assert.equal(/<(input|a|button)\b/.test(html), false)
  })
  it("flottement réservé à motion-safe ; rendu serveur en mouvement réduit (aucun suivi du pointeur)", () => {
    const src = read("src/components/auth/LoginCrew.tsx")
    assert.match(src, /motion-safe:animate-\[login-crew-bob/)
    assert.doesNotMatch(src, /(?<!motion-safe:)animate-\[login-crew-bob/)
    assert.match(src, /useSyncExternalStore\(subscribeReduced, [^,]+, \(\) => true\)/, "instantané serveur = mouvement réduit")
    assert.match(src, /const follow = !reducedMotion && focusedField === null/)
  })
  it("yeux fermés quand le mot de passe masqué a le focus ; ouverts sinon", () => {
    // Œil fermé = orbite et pupille masquées (opacity 0) : 6 yeux × 2 cercles.
    const hidden = (props: Record<string, unknown>) => (renderToStaticMarkup(createElement(LoginCrew, props)).match(/<circle[^>]*opacity="0"/g) ?? []).length
    assert.equal(hidden({ focusedField: "password", passwordVisible: false }), 12)
    assert.equal(hidden({ focusedField: "password", passwordVisible: true }), 0)
    assert.equal(hidden({ focusedField: "email", passwordVisible: false }), 0)
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
  it("les rappels vers l'illustration ne transmettent que le nom du champ et l'état « affiché », jamais une valeur", () => {
    const src = read("src/components/auth/LoginForm.tsx")
    const calls = [...src.matchAll(/on(?:FieldFocus|PasswordVisibilityChange)\?\.\(([^)]*)\)/g)].map((m) => m[1].trim())
    assert.deepEqual(calls.sort(), ['"email"', '"password"', "next", "null", "null"].sort())
    const crew = read("src/components/auth/LoginCrew.tsx")
    assert.doesNotMatch(crew, /\.value\b|localStorage|sessionStorage|fetch\(/)
  })
})
