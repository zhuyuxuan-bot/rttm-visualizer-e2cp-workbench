type KeyboardLikeEvent = {
  isComposing?: boolean
  target?: EventTarget | null
}

type ElementLike = {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

function asElementLike(target: unknown): ElementLike | null {
  if (!target || typeof target !== 'object') return null
  return target as ElementLike
}

export function isEditableKeyboardTarget(target: unknown): boolean {
  const element = asElementLike(target)
  if (!element) return false

  const tagName = typeof element.tagName === 'string'
    ? element.tagName.toUpperCase()
    : ''

  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true
  }

  if (element.isContentEditable) return true

  if (typeof element.closest === 'function') {
    return Boolean(element.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
  }

  return false
}

export function shouldSuppressGlobalShortcut(event: KeyboardLikeEvent, activeElement?: unknown): boolean {
  return Boolean(
    event.isComposing ||
    isEditableKeyboardTarget(event.target) ||
    isEditableKeyboardTarget(activeElement)
  )
}
