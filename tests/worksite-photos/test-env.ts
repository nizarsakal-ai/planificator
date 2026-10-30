/**
 * Environnement de test typé `NodeJS.ProcessEnv` sans cast : Next.js rend `NODE_ENV` obligatoire dans ce type.
 * Les modules du lot ne lisent jamais `NODE_ENV` ; seules les variables passées comptent.
 */
export function testEnv(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...values, NODE_ENV: "test" }
}
