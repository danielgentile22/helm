/** Which shape the app is in. Above 900px (issue #26) the list and the open
    thread sit side by side; below it, one screen at a time. */

export type Layout = "single" | "split";

const wide = matchMedia("(min-width: 900px)");
const read = (matches: boolean): Layout => (matches ? "split" : "single");

class Viewport {
  #mode = $state<Layout>(read(wide.matches));

  constructor() {
    wide.addEventListener("change", (e) => (this.#mode = read(e.matches)));
  }

  get mode(): Layout {
    return this.#mode;
  }
}

export const layout = new Viewport();
