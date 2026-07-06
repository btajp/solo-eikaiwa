import { QUICK_KINDS, type Menu, type QuickKind } from "../menu";
import { DOMAINS, type Domain } from "../content";
import { json, exact, type RouteEntry } from "./http";

export type MenuRoutesDeps = {
  buildMenu: (minutes: 60 | 30) => Menu;
  buildQuick: (kind: QuickKind, domain?: Domain) => Menu;
};

function handleMenuToday(url: URL, deps: MenuRoutesDeps): Response {
  const raw = url.searchParams.get("minutes") ?? "60";
  if (raw !== "60" && raw !== "30") return json({ error: "minutes must be 60 or 30" }, 400);
  const minutes = Number(raw) as 60 | 30;
  return json(deps.buildMenu(minutes));
}

function handleMenuQuick(url: URL, deps: MenuRoutesDeps): Response {
  const kind = url.searchParams.get("kind") ?? "";
  if (!(QUICK_KINDS as readonly string[]).includes(kind)) {
    return json({ error: `kind must be one of: ${QUICK_KINDS.join(", ")}` }, 400);
  }
  // domain はロールプレイのドメイン明示指定（任意・additive）
  const domainRaw = url.searchParams.get("domain");
  if (domainRaw !== null && !(DOMAINS as readonly string[]).includes(domainRaw)) {
    return json({ error: `domain must be one of: ${DOMAINS.join(", ")}` }, 400);
  }
  return json(deps.buildQuick(kind as QuickKind, (domainRaw as Domain | null) ?? undefined));
}

export function makeMenuRoutes(deps: MenuRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/menu/today", (_req, url) => handleMenuToday(url, deps)),
    exact("GET", "/api/menu/quick", (_req, url) => handleMenuQuick(url, deps)),
  ];
}
