import { describe, expect, test } from "bun:test";
import { STR } from "./i18n";

describe("provider location disclosure i18n", () => {
  test("EN/JAともOpenAI互換割当をlocalと断定せずremote送信を説明する", () => {
    expect(STR.en.settings.targetLocal).toBe("OpenAI-compatible");
    expect(STR.ja.settings.targetLocal).toBe("OpenAI互換");
    expect(STR.en.settings.endpointRemoteDisclosure).toContain("leave your Mac");
    expect(STR.ja.settings.endpointRemoteDisclosure).toContain("Macの外へ送信");
  });

  test("EN/JAのAboutがローカル保存と選択providerへの送信を区別する", () => {
    expect(STR.en.about.desc).toContain("stay on your Mac");
    expect(STR.en.about.desc).toContain("providers you select");
    expect(STR.ja.about.desc).toContain("このMacに保存");
    expect(STR.ja.about.desc).toContain("プロバイダへ送信");
  });
});
