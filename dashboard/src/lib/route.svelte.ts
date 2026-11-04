export type Route =
  | { tab: "projects"; slug: string | null }
  | { tab: "ideas" }
  | { tab: "background" }
  | { tab: "devices" };

export type Tab = Route["tab"];

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

export function parse(pathname: string): Route {
  const parts = pathname.split("/").filter((p) => p !== "");
  const [first, second] = parts;
  if (first === "ideas" && parts.length === 1) return { tab: "ideas" };
  if (first === "background" && parts.length === 1) return { tab: "background" };
  if (first === "devices" && parts.length === 1) return { tab: "devices" };
  if (first === "projects" && second !== undefined && parts.length === 2) {
    return { tab: "projects", slug: decode(second) };
  }
  return { tab: "projects", slug: null };
}

export function href(route: Route): string {
  if (route.tab === "projects") {
    return route.slug === null ? "/projects" : `/projects/${encodeURIComponent(route.slug)}`;
  }
  return `/${route.tab}`;
}

export const router = $state<{ current: Route }>({ current: parse(location.pathname) });

export function navigate(route: Route): void {
  history.pushState(null, "", href(route));
  router.current = route;
  scrollTo(0, 0);
}

/** The onclick of an `<a href>` that navigates in place, leaving command-click and friends to the browser. */
export function follow(event: MouseEvent, route: Route): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(route);
}

addEventListener("popstate", () => {
  router.current = parse(location.pathname);
});
