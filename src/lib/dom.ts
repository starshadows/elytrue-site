export function setOneTimeStyles(
  element: HTMLElement,
  styles: Partial<CSSStyleDeclaration>,
): void {
  Object.assign(element.style, styles)
  const cleanup = () => {
    for (const property of Object.keys(styles)) {
      element.style.removeProperty(
        property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      )
    }
    element.removeEventListener('transitionend', cleanup)
  }
  element.addEventListener('transitionend', cleanup)
}
