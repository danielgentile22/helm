/** The live route: reactive state driven by history and popstate. */

import { parseRoute, type Route } from "./route";

const fromLocation = (): Route => parseRoute(location.pathname, location.search);

class Router {
  route = $state<Route>(fromLocation());

  navigate(path: string): void {
    history.pushState(null, "", path);
    this.route = fromLocation();
  }
}

export const router = new Router();

window.addEventListener("popstate", () => {
  router.route = fromLocation();
});
