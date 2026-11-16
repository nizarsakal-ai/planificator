// Remplace les server actions par des enregistreurs : le banc observe exactement ce que chaque formulaire enverrait.
type Call = { action: string; id?: string; fields: Record<string, string> }
declare global { interface Window { __calls: Call[] } }
window.__calls = []
const record = (action: string, fd: FormData, id?: string) => {
  const fields: Record<string, string> = {}
  fd.forEach((v, k) => { fields[k] = String(v) })
  window.__calls.push({ action, id, fields })
}
export async function createClient(fd: FormData) { record("createClient", fd); return { client: { id: "c-new", name: String(fd.get("name")) } } }
export async function updateClient(id: string, fd: FormData) { record("updateClient", fd, id); return { client: { id, name: String(fd.get("name")) } } }
export async function createChantierWithId(fd: FormData) { record("createChantierWithId", fd); return { worksiteId: "w-new" } }
export async function updateChantier(id: string, fd: FormData) { record("updateChantier", fd, id); return {} }
export async function deleteClient() { return {} }
export async function toggleClientActive() { return {} }
