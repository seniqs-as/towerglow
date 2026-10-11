/**
 * A button that erases something only on the second click.
 *
 * Two clicks and not a dialog: a browser confirm blocks the page, and a single
 * click erasing a whole meeting -- or a whole board, or every report -- is one
 * click too few. The first click arms it and says so on the button itself,
 * where you are looking; left alone it disarms after `ms`.
 *
 * One place for the three panels that start over (Planning, Board, Reports):
 * three copies of the same four lines would drift at the first edit, and
 * what drifts is exactly the part that protects you.
 *
 * `data-armed` is for the CSS. The element is typed by what it uses, so the
 * test drives it without a DOM.
 */
export interface Armable {
  textContent: string | null;
  dataset: Record<string, string | undefined>;
  addEventListener(type: 'click', fn: () => void): void;
}

export function twoClicks(
  button: Armable, idle: string, armed: string, onConfirm: () => void, ms = 4000,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    button.textContent = idle;
    button.dataset['armed'] = 'false';
  };
  disarm();
  button.addEventListener('click', () => {
    if (!timer) {
      button.textContent = armed;
      button.dataset['armed'] = 'true';
      timer = setTimeout(disarm, ms);
      return;
    }
    disarm();
    onConfirm();
  });
}
