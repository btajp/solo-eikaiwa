import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings, writeSettings } from "../settings";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "settings-")), "settings.json");
}

describe("settings", () => {
  test("未作成なら anchor は空文字", () => {
    expect(readSettings(tmpFile())).toEqual({ anchor: "" });
  });

  test("write → read ラウンドトリップ", () => {
    const file = tmpFile();
    writeSettings({ anchor: "朝コーヒーを淹れたら1ドリル" }, file);
    expect(readSettings(file)).toEqual({ anchor: "朝コーヒーを淹れたら1ドリル" });
  });

  test("破損JSONと不正形状はデフォルトにフォールバック", () => {
    const file = tmpFile();
    writeFileSync(file, "{broken");
    expect(readSettings(file)).toEqual({ anchor: "" });
    writeFileSync(file, JSON.stringify({ anchor: 42 }));
    expect(readSettings(file)).toEqual({ anchor: "" });
  });
});
