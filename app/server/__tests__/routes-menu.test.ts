import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_MENU, FAKE_QUICK_MENU, makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

describe("routes: menu", () => {
  test("GET /api/menu/today はデフォルト60分のメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/menu/today"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_MENU);
  });

  test("minutes=30 が渡る / 不正値は400", async () => {
    const seen: number[] = [];
    const { deps } = makeTestDeps({
      buildMenu: (m) => { seen.push(m); return { ...FAKE_MENU, minutes: m }; },
    });
    const handler = makeFetchHandler(deps);
    const ok = await handler(getReq("/api/menu/today?minutes=30"));
    expect(ok.status).toBe(200);
    expect(seen).toEqual([30]);
    const bad = await handler(getReq("/api/menu/today?minutes=45"));
    expect(bad.status).toBe(400);
  });
});

describe("routes: quick menu / progress / settings", () => {
  test("GET /api/menu/quick?kind=warmup は200でメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/menu/quick?kind=warmup"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_QUICK_MENU);
  });

  test("GET /api/menu/quick の不正kindとkind欠落は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    for (const q of ["?kind=bogus", ""]) {
      const res = await handler(getReq(`/api/menu/quick${q}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("kind");
    }
  });

  test("GET /api/settings と PUT /api/settings のラウンドトリップ", async () => {
    let stored = { anchor: "" };
    const { deps } = makeTestDeps({
      getSettings: () => stored,
      saveSettings: (s) => { stored = s; },
    });
    const handler = makeFetchHandler(deps);
    const put = await handler(new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "朝コーヒーを淹れたら1ドリル" }),
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    const got = await handler(getReq("/api/settings"));
    expect(await got.json()).toEqual({ anchor: "朝コーヒーを淹れたら1ドリル" });
  });

  test("PUT /api/settings は anchor が string でない・200字超・不正JSONで400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const bad1 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: 42 }),
    }));
    expect(bad1.status).toBe(400);
    const bad2 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "x".repeat(201) }),
    }));
    expect(bad2.status).toBe(400);
    const bad3 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{broken",
    }));
    expect(bad3.status).toBe(400);
  });
});
