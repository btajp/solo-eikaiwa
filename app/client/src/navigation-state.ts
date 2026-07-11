import type { RouteMode } from "./route-state";

export type NavigationModeKind = RouteMode["kind"] | "session";

/** セッションはホームから始まる深いフローなので、サイドバーではホームを現在地として示す。 */
export function isHomeNavigationActive(modeKind: NavigationModeKind): boolean {
  return modeKind === "start" || modeKind === "session";
}
