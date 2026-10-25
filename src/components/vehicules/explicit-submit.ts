import type { FormEvent, KeyboardEvent } from "react"

/** Enter edits a field; only an explicitly activated validation button saves it. */
export function preventImplicitEnter(event: KeyboardEvent<HTMLElement>) {
  const tag = (event.target as HTMLElement).tagName
  if (event.key === "Enter" && !["TEXTAREA", "BUTTON", "A"].includes(tag)) event.preventDefault()
}

export function isExplicitSubmit(event: FormEvent<HTMLFormElement>): boolean {
  event.preventDefault()
  return (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-explicit-submit") === "true"
}
