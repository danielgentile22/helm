const query = matchMedia("(min-width: 900px)");

export const layout = $state({ wide: query.matches });

query.addEventListener("change", (event) => {
  layout.wide = event.matches;
});
