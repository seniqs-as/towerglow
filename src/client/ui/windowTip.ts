/**
 * The name of whoever works behind a window, only while you hover over it.
 *
 * In the scene the windows carry no text: the colour says WHO is working, and
 * a name beside every light would fill the facade with text. The name is
 * there, but you ask for it, by pointing at the window.
 */
export class WindowTip {
  #node: HTMLElement;
  #text = '';

  constructor(host: HTMLElement) {
    this.#node = document.createElement('div');
    this.#node.className = 'window-tip';
    this.#node.setAttribute('role', 'tooltip');
    this.#node.hidden = true;
    host.appendChild(this.#node);
  }

  /** `color`: the window's own, so it is clear which of the nearby lights is being read. */
  show(text: string, color: string, x: number, y: number): void {
    if (text !== this.#text) {
      this.#node.textContent = text;
      this.#text = text;
    }
    this.#node.style.setProperty('--c', color);
    this.#node.hidden = false;
    // Beside the pointer, not under it: it would cover the very window
    // being looked at. Near the right edge it flips to the other side.
    const w = this.#node.offsetWidth;
    const left = x + 14 + w > window.innerWidth - 8 ? x - 14 - w : x + 14;
    this.#node.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(y + 14)}px, 0)`;
  }

  hide(): void {
    if (!this.#node.hidden) this.#node.hidden = true;
  }
}
