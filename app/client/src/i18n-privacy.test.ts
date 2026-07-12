import { describe, expect, test } from "bun:test";
import { STR } from "./i18n";

describe("provider location disclosure i18n", () => {
  test("EN/JAともOpenAI互換割当をlocalと断定せずremote送信を説明する", () => {
    expect(STR.en.settings.targetLocal).toBe("OpenAI-compatible");
    expect(STR.ja.settings.targetLocal).toBe("OpenAI互換");
    expect(STR.en.settings.endpointRemoteDisclosure).toContain("leave your Mac");
    expect(STR.ja.settings.endpointRemoteDisclosure).toContain("Macの外へ送信");
  });

  test("EN/JAの外部リンク名が行き先と新しいタブで開くことを伝える", () => {
    expect(STR.en.footer.githubLabel).toContain("GitHub repository");
    expect(STR.en.footer.websiteLabel).toContain("opens in a new tab");
    expect(STR.ja.footer.githubLabel).toContain("GitHub リポジトリ");
    expect(STR.ja.footer.websiteLabel).toContain("新しいタブで開く");
    expect(STR.en.footer.privacyLabel).toBe("Privacy policy");
    expect(STR.ja.footer.privacyLabel).toBe("プライバシーポリシー");
    expect(STR.en.footer.copyright).toBe(STR.ja.footer.copyright);
  });
});
