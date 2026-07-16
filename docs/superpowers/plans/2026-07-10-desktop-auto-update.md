# デスクトップ署名・公証 + 半自動アップデート 実装計画（v0.29）

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Developer ID 署名 + 公証済みの dmg を配布し、起動時チェック → ネイティブダイアログ → 1クリック更新の半自動アップデートを tauri-plugin-updater で実現する

**Architecture:** 更新 UX は全て Rust 側（ダイアログ・メニュー）で完結し、webview（localhost 配信の本体 UI）への IPC はゼロ権限を維持する。署名・公証・updater 署名はリリーススクリプトが環境変数で注入し、リポジトリの `tauri.conf.json` は開発ビルド（ad-hoc）挙動を変えない。`createUpdaterArtifacts` は committed config に入れず overlay 専用（.sig 生成条件の曖昧さを構造的に回避）。

**Tech Stack:** tauri 2.11.x / tauri-plugin-updater 2（→2.10.1）/ tauri-plugin-dialog 2（→2.7.1）/ sys-locale / minisign（Tauri 内蔵）/ notarytool（App Store Connect API キー方式）

**設計の正:** spec `docs/superpowers/specs/2026-07-10-desktop-signing-auto-update-design.md` + 調査 Workflow（2026-07-10・7エージェント）+ ソース実測3件:

- tauri-bundler 2.9.4 `src/bundle/macos/app.rs:77-132`: sign_paths = frameworks + externalBin + main binary + .app のみ。**`copy_resources` の成果物は署名対象外** → Resources/whisper-bin の Mach-O（whisper-cli + dylib 4本 + .so 5本）はプレ署名しないと公証で落ちる
- tauri 2.11.2 `src/app.rs:588-603, 1419-1428`: `AppHandle::restart()` を**非メインスレッドから呼ぶと** `request_exit` → `RunEvent::Exit` がコールバックに配送されてから restart される → 既存 `sidecar::kill_on_exit` が乗るので追加配線不要。メインスレッドから呼ぶと `cleanup_before_exit()` 直行（Exit イベントはコールバックに来ない）ので**必ず async タスク内から呼ぶ**
- 調査確定: latest.json の `signature` は `.sig` ファイルの**中身**（パスではない）/ 公証 env は Apple ID 方式が API キー方式より先に評価される（`APPLE_ID` を unset してから）/ Tauri が notarize+staple するのは `.app` のみ（dmg は codesign のみ・updater tar.gz は staple 済み .app の tar）/ 認証 env が無いと公証は**警告のみでスキップ**されるため検証必須 / `blocking_show` はメインスレッド禁止（spawn_blocking で呼ぶ）/ macOS のメニューは top-level に Submenu しか置けず、最初の Submenu がアプリメニューになる

## Global Constraints

- 検証ゲート3種（`cd app && bun test` / `bun run typecheck` / `cd app/client && bun run build`）+ `cargo test --lib`（desktop/src-tauri）を各コミット前に実行
- 研究制約: 情報的トーンのみ（警告調・叱責調・強要なし）。更新は必ずユーザーの明示クリックで実行
- capabilities/default.json は変更しない（attached app origin への IPC ゼロ権限を維持）
- `tauri.conf.json` の `signingIdentity: "-"` は変更しない（開発ビルドは ad-hoc のまま）
- secrets（Apple 証明書・API キー・updater 秘密鍵）はリポジトリ・GitHub に置かない
- ダイアログ文言は日英（システムロケール切替）。文言追加時は両言語同時
- コミットは Conventional Commits 日本語（既存流儀）

---

### Task 1: updater 鍵生成 + 依存追加 + プラグイン登録 + 設定

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml`
- Modify: `desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src-tauri/tauri.updater-artifacts.conf.json`
- Modify: `desktop/src-tauri/src/lib.rs`（プラグイン登録のみ）

**Interfaces:**
- Produces: `plugins.updater.pubkey`/`endpoints` 設定済みの config、`tauri_plugin_updater`/`tauri_plugin_dialog`/`sys-locale` クレート（Task 2-4 が使う）

- [ ] **Step 1: updater 鍵ペアを生成**（パスワード無し・ローカルのみ。`~/.tauri/` はリポ外）

```bash
mkdir -p ~/.tauri
cargo tauri signer generate -w ~/.tauri/solo-eikaiwa-updater.key --password ""
cat ~/.tauri/solo-eikaiwa-updater.key.pub   # → Step 3 で config に貼る
chmod 600 ~/.tauri/solo-eikaiwa-updater.key
```

Expected: `.key`（秘密鍵）と `.key.pub`（公開鍵・1行 base64 系文字列）が生成される。
**注意: 秘密鍵を失うと既存ユーザーへ自動更新を届ける手段が永久に失われる**（ユーザータスクとしてバックアップ必須）。

- [ ] **Step 2: Cargo.toml に依存追加**

```toml
# [dependencies] に追記
tauri-plugin-dialog = "2"
tauri-plugin-updater = "2"
sys-locale = "0.3"
```

- [ ] **Step 3: tauri.conf.json に updater 設定を追加**（`"bundle"` と同階層に `"plugins"`）

```json
  "plugins": {
    "updater": {
      "pubkey": "（Step 1 の .key.pub の中身をそのまま貼る）",
      "endpoints": [
        "https://github.com/btajp/solo-eikaiwa/releases/latest/download/latest.json"
      ]
    }
  }
```

`createUpdaterArtifacts` はここに**入れない**（開発ビルドの挙動を変えないため。overlay で必要時のみ有効化）。

- [ ] **Step 4: overlay `tauri.updater-artifacts.conf.json` を作成**（リリース・E2E ビルド専用）

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

- [ ] **Step 5: lib.rs にプラグイン登録**（既存 `.plugin(tauri_plugin_shell::init())` の直後）

```rust
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
```

- [ ] **Step 6: ビルド確認**

Run: `cd desktop/src-tauri && cargo check && cargo test --lib`
Expected: コンパイル成功・既存22テスト green

- [ ] **Step 7: Commit** `feat: updater/dialogプラグイン導入と更新署名鍵の配線（挙動変更なし）`

### Task 2: updater.rs — 文言・分岐の純関数（TDD）

**Files:**
- Create: `desktop/src-tauri/src/updater.rs`
- Modify: `desktop/src-tauri/src/lib.rs`（`mod updater;` 追加）

**Interfaces:**
- Produces: `pick_lang(Option<&str>) -> Lang` / `update_prompt_text(Lang, current, latest) -> PromptText` / `manual_latest_text(Lang, current) -> InfoText` / `install_failed_text(Lang) -> InfoText` / `check_menu_label(Lang) -> &'static str` / `RELEASES_URL`（Task 3-4 が使う）

- [ ] **Step 1: 失敗するテストを書く**（updater.rs 末尾。実装は空のまま先にテストから）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_lang_ja_for_japanese_locales() {
        assert_eq!(pick_lang(Some("ja")), Lang::Ja);
        assert_eq!(pick_lang(Some("ja-JP")), Lang::Ja);
    }

    #[test]
    fn pick_lang_en_for_others_and_missing() {
        assert_eq!(pick_lang(Some("en-US")), Lang::En);
        assert_eq!(pick_lang(Some("fr")), Lang::En);
        assert_eq!(pick_lang(None), Lang::En);
    }

    #[test]
    fn update_prompt_contains_both_versions() {
        let t = update_prompt_text(Lang::Ja, "0.29.0", "0.30.0");
        assert!(t.body.contains("0.29.0") && t.body.contains("0.30.0"));
        let t = update_prompt_text(Lang::En, "0.29.0", "0.30.0");
        assert!(t.body.contains("0.29.0") && t.body.contains("0.30.0"));
    }

    #[test]
    fn install_failed_text_mentions_releases_url() {
        // 適用失敗時は手動DL先（Releases）を必ず情報的に案内する（研究制約: 警告調・強要なし）
        assert!(install_failed_text(Lang::Ja).body.contains(RELEASES_URL));
        assert!(install_failed_text(Lang::En).body.contains(RELEASES_URL));
    }

    #[test]
    fn manual_latest_text_mentions_current_version() {
        assert!(manual_latest_text(Lang::Ja, "0.29.0").body.contains("0.29.0"));
        assert!(manual_latest_text(Lang::En, "0.29.0").body.contains("0.29.0"));
    }
}
```

- [ ] **Step 2: 失敗を確認** — Run: `cargo test --lib updater` / Expected: コンパイルエラー（型未定義）

- [ ] **Step 3: 最小実装**

```rust
//! 半自動アップデートのUI文言・分岐（純関数部）。
//! 更新UXはRust側ネイティブダイアログで完結させる（webviewへのIPCゼロ権限を維持するため）。

pub(crate) const RELEASES_URL: &str = "https://github.com/btajp/solo-eikaiwa/releases";

#[derive(Debug, PartialEq, Clone, Copy)]
pub(crate) enum Lang { Ja, En }

/// システムロケール文字列からダイアログ言語を選ぶ。ja* のみ日本語、他は英語。
pub(crate) fn pick_lang(locale: Option<&str>) -> Lang {
    match locale {
        Some(l) if l.starts_with("ja") => Lang::Ja,
        _ => Lang::En,
    }
}

pub(crate) struct PromptText {
    pub title: String,
    pub body: String,
    pub ok: String,
    pub cancel: String,
}

pub(crate) struct InfoText {
    pub title: String,
    pub body: String,
}

pub(crate) fn update_prompt_text(lang: Lang, current: &str, latest: &str) -> PromptText {
    match lang {
        Lang::Ja => PromptText {
            title: "アップデート".to_string(),
            body: format!("solo-eikaiwa v{latest} が利用可能です（現在 v{current}）。\n今すぐダウンロードして更新しますか？\n更新後は自動で再起動します。"),
            ok: "更新する".to_string(),
            cancel: "今回はしない".to_string(),
        },
        Lang::En => PromptText {
            title: "Update Available".to_string(),
            body: format!("solo-eikaiwa v{latest} is available (you have v{current}).\nDownload and install now?\nThe app will restart automatically."),
            ok: "Update".to_string(),
            cancel: "Not Now".to_string(),
        },
    }
}

pub(crate) fn manual_latest_text(lang: Lang, current: &str) -> InfoText {
    match lang {
        Lang::Ja => InfoText {
            title: "アップデート".to_string(),
            body: format!("お使いのバージョン（v{current}）が最新です。"),
        },
        Lang::En => InfoText {
            title: "Up to Date".to_string(),
            body: format!("You're on the latest version (v{current})."),
        },
    }
}

pub(crate) fn install_failed_text(lang: Lang) -> InfoText {
    match lang {
        Lang::Ja => InfoText {
            title: "アップデート".to_string(),
            body: format!("自動更新を完了できませんでした。\n最新版は以下から手動でダウンロードできます:\n{RELEASES_URL}\n（アプリを /Applications に置いてから起動すると自動更新できるようになります）"),
        },
        Lang::En => InfoText {
            title: "Update".to_string(),
            body: format!("The update could not be installed automatically.\nYou can download the latest version manually:\n{RELEASES_URL}\n(Moving the app into /Applications enables automatic updates.)"),
        },
    }
}

pub(crate) fn check_menu_label(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "アップデートを確認…",
        Lang::En => "Check for Updates…",
    }
}
```

lib.rs 先頭に `mod updater;` を追加。

- [ ] **Step 4: テスト green を確認** — Run: `cargo test --lib updater` / Expected: 5 passed
- [ ] **Step 5: Commit** `feat: 更新ダイアログの文言・言語選択の純関数（日英・情報的トーン）`

### Task 3: updater.rs — チェック→ダイアログ→適用→再起動フロー

**Files:**
- Modify: `desktop/src-tauri/src/updater.rs`
- Modify: `desktop/src-tauri/src/lib.rs`（setup で起動時チェックを spawn）

**Interfaces:**
- Consumes: Task 2 の純関数
- Produces: `spawn_startup_check(AppHandle)` / `spawn_manual_check(AppHandle)`（Task 4 のメニューが使う）

- [ ] **Step 1: フロー実装**（updater.rs に追記）

```rust
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// 起動時の自動チェック。非ブロッキング（起動・attach・sidecar spawn を一切待たせない）。
/// 失敗（オフライン・GitHub不達等）はログのみで無言スキップ（起動時にダイアログを出さない）。
pub fn spawn_startup_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check_and_prompt(app, false).await {
            log::warn!("updater: startup check failed (skipped quietly): {e}");
        }
    });
}

/// メニュー「アップデートを確認…」からの手動チェック。結果は常にダイアログで返す。
pub fn spawn_manual_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let lang = current_lang();
        match check_and_prompt(app.clone(), true).await {
            Ok(()) => {}
            Err(e) => {
                log::warn!("updater: manual check failed: {e}");
                // 手動時は失敗も情報的に伝える（起動時と違い、ユーザーが結果を待っているため）
                let t = install_failed_text(lang);
                app.dialog()
                    .message(&t.body)
                    .title(&t.title)
                    .kind(MessageDialogKind::Info)
                    .show(|_| {});
            }
        }
    });
}

fn current_lang() -> Lang {
    pick_lang(sys_locale::get_locale().as_deref())
}

async fn check_and_prompt(app: AppHandle, manual: bool) -> tauri_plugin_updater::Result<()> {
    let updater = app.updater()?;
    let lang = current_lang();
    let Some(update) = updater.check().await? else {
        if manual {
            let current = app.package_info().version.to_string();
            let t = manual_latest_text(lang, &current);
            app.dialog()
                .message(&t.body)
                .title(&t.title)
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        return Ok(());
    };

    let t = update_prompt_text(lang, &update.current_version, &update.version);
    let dialog = app
        .dialog()
        .message(&t.body)
        .title(&t.title)
        .buttons(MessageDialogButtons::OkCancelCustom(t.ok, t.cancel));
    // blocking_show はメインスレッド禁止（docs.rs 明記）。tokio の blocking プールで待つ。
    let confirmed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false);
    if !confirmed {
        // 「今回はしない」: 何も記録しない・次回起動時にまた1回だけ聞く（情報的・ペナルティなし）
        log::info!("updater: user declined update to v{}", update.version);
        return Ok(());
    }

    log::info!("updater: downloading v{} ...", update.version);
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            log::info!("updater: installed v{}; restarting", update.version);
            // 非メインスレッド（async タスク）からの restart() は request_exit 経由で
            // RunEvent::Exit をコールバックに配送してから再起動する（tauri 2.11.2
            // src/app.rs:594-603, 1419-1428 実測）。既存の sidecar::kill_on_exit が
            // ここで走るため、旧 sidecar への孤児化・旧サーバへの再attachは起きない。
            app.restart();
        }
        Err(e) => {
            log::error!("updater: install failed: {e}");
            let t = install_failed_text(lang);
            app.dialog()
                .message(&t.body)
                .title(&t.title)
                .kind(MessageDialogKind::Info)
                .show(|_| {});
            Ok(())
        }
    }
}
```

注意: `download_and_install` の成功分岐は `app.restart()`（`-> !`）で戻らないため、`match` の Ok 腕は型上 `!` → そのまま関数末尾に到達しない。Err 腕は `Ok(())` を返す。

- [ ] **Step 2: lib.rs の setup に起動時チェックを追加**（`attach::spawn_initial_attach` の直後）

```rust
      updater::spawn_startup_check(app.handle().clone());
```

- [ ] **Step 3: ビルド・テスト** — Run: `cargo check && cargo test --lib` / Expected: green（フローは実機E2E＝Task 6 で検証）
- [ ] **Step 4: Commit** `feat: 起動時アップデートチェックと1クリック更新（非ブロッキング・失敗は無言スキップ）`

### Task 4: メニュー「アップデートを確認…」

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `updater::spawn_manual_check` / `updater::check_menu_label` / `updater::pick_lang`

- [ ] **Step 1: メニュー構築 + イベント処理を lib.rs に実装**

```rust
use tauri::menu::{Menu, MenuItem};

const MENU_ID_CHECK_UPDATES: &str = "check-for-updates";

// setup クロージャ内（spawn_startup_check の後）に追加:
      // macOS: 最初の Submenu がアプリ名メニューになる（公式仕様）。Menu::default() の
      // 先頭 Submenu（About(0)/Separator(1)/Services(2)/...）の About 直後 = index 1 に
      // 「アップデートを確認…」を挿入する（Sparkle 系アプリと同じ慣例配置）。
      let menu = Menu::default(app.handle())?;
      if let Some(app_submenu) = menu.items()?.first().and_then(|k| k.as_submenu().cloned()) {
        let lang = updater::pick_lang(sys_locale::get_locale().as_deref());
        let item = MenuItem::with_id(
          app,
          MENU_ID_CHECK_UPDATES,
          updater::check_menu_label(lang),
          true,
          None::<&str>,
        )?;
        app_submenu.insert(&item, 1)?;
      }
      app.set_menu(menu)?;

// Builder チェーン（.invoke_handler の後ろ等）に追加:
    .on_menu_event(|app, event| {
      if event.id() == MENU_ID_CHECK_UPDATES {
        updater::spawn_manual_check(app.clone());
      }
    })
```

- [ ] **Step 2: ビルド・テスト** — Run: `cargo check && cargo test --lib` / Expected: green
- [ ] **Step 3: dev 実機確認** — Run: `cargo tauri dev` → メニューバーの solo-eikaiwa メニューに「アップデートを確認…」が About 直後に出ること・クリックで「最新です」ダイアログ（GitHub の latest.json は v0.28.0 で current と同じか下）
- [ ] **Step 4: Commit** `feat: アプリメニューに「アップデートを確認…」を追加（手動チェック）`

### Task 5: リリーススクリプト `scripts/release-desktop.sh`

**Files:**
- Create: `scripts/release-desktop.sh`（実行権限付き）

**Interfaces:**
- Consumes: `~/.config/solo-eikaiwa/release.env`（無ければテンプレート生成して終了）
- Produces: 署名・公証・staple 済み dmg + `.app.tar.gz`/`.sig` + `latest.json` + GitHub Release（draft→publish）

- [ ] **Step 1: スクリプト作成**（要点のみ抜粋ではなく、以下をそのまま実装する）

```bash
#!/usr/bin/env bash
# solo-eikaiwa デスクトップアプリのリリース（署名・公証・updater アーティファクト・GitHub Release）。
# 使い方: ./scripts/release-desktop.sh 0.29.0
# 前提: ~/.config/solo-eikaiwa/release.env（無ければテンプレートを生成して終了する）
set -euo pipefail

VERSION="${1:?使い方: $0 <version 例: 0.29.0>}"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
ENV_FILE="${SOLO_EIKAIWA_RELEASE_ENV:-$HOME/.config/solo-eikaiwa/release.env}"
BUNDLE_DIR="$REPO_DIR/desktop/src-tauri/target/release/bundle"

# 0. release.env（無ければテンプレート生成して人間に返す）
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname -- "$ENV_FILE")"
  cat > "$ENV_FILE" <<'TMPL'
# solo-eikaiwa リリース用シークレット（このファイルはリポジトリ外・chmod 600 推奨）
# --- Apple 署名（security find-identity -v -p codesigning の表示をそのまま） ---
APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR ORG (TEAMID)"
# --- 公証（App Store Connect API キー方式） ---
APPLE_API_KEY="ABC123DEFG"                                    # Key ID（10桁）
APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"       # Issuer ID（UUID）
APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8"
# --- updater 署名（Tauri minisign） ---
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/solo-eikaiwa-updater.key"   # パス or 鍵の中身
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""                                # 鍵にパスワードが無ければ空のまま
TMPL
  chmod 600 "$ENV_FILE"
  echo "release.env のテンプレートを生成しました: $ENV_FILE"
  echo "値を埋めてから再実行してください。"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
for v in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY; do
  [[ -n "${!v:-}" ]] || { echo "ERROR: $ENV_FILE の $v が未設定です" >&2; exit 1; }
done
[[ -f "$APPLE_API_KEY_PATH" ]] || { echo "ERROR: APPLE_API_KEY_PATH が存在しません: $APPLE_API_KEY_PATH" >&2; exit 1; }
export APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH \
       TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
# Apple ID 方式が API キー方式より先に評価される（tauri-cli 実装）ため、混入していたら外す
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD 2>/dev/null || true

echo "== solo-eikaiwa desktop release v$VERSION =="

# 1. バージョン整合（4点 + CHANGELOG + タグ未使用）
jq_ver() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$1"; }
[[ "$(jq_ver "$REPO_DIR/app/package.json")" == "$VERSION" ]] || { echo "ERROR: app/package.json の version が $VERSION ではありません" >&2; exit 1; }
[[ "$(jq_ver "$REPO_DIR/desktop/src-tauri/tauri.conf.json")" == "$VERSION" ]] || { echo "ERROR: tauri.conf.json の version が $VERSION ではありません" >&2; exit 1; }
grep -q "^version = \"$VERSION\"" "$REPO_DIR/desktop/src-tauri/Cargo.toml" || { echo "ERROR: Cargo.toml の version が $VERSION ではありません" >&2; exit 1; }
grep -q "^## \[$VERSION\]" "$REPO_DIR/CHANGELOG.md" || { echo "ERROR: CHANGELOG.md に [$VERSION] 節がありません" >&2; exit 1; }
if git -C "$REPO_DIR" rev-parse "v$VERSION" >/dev/null 2>&1; then echo "ERROR: タグ v$VERSION は既に存在します" >&2; exit 1; fi

# 2. 検証ゲート3種
(cd "$REPO_DIR/app" && bun test && bun run typecheck)
(cd "$REPO_DIR/app/client" && bun run build)

# 3. sidecar・resources 構築
"$REPO_DIR/desktop/build-sidecar.sh"

# 4. whisper-bin の Mach-O をプレ署名
#    tauri-bundler は Resources 配下を署名しない（bundler 2.9.4 app.rs 実測）ため、
#    ここで署名しておかないと公証が unsigned binary で必ず落ちる。
#    whisper-cli は JIT 不要なのでエンタイトルメント無しの hardened runtime 署名でよい
#    （dylib/.so は同一 Team ID 署名になるため library validation も通る）。
echo "-- whisper-bin プレ署名"
find "$REPO_DIR/desktop/src-tauri/resources/whisper-bin" -type f | while read -r f; do
  if file "$f" | grep -q "Mach-O"; then
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$f"
  fi
done

# 5. ビルド（署名・公証は bundler が env から自動実行。updater artifacts は overlay で有効化）
(cd "$REPO_DIR/desktop/src-tauri" && cargo tauri build --config tauri.updater-artifacts.conf.json)

# 6. 生成物の存在と署名・公証を検証（公証は env 不備だと警告のみでスキップされるため必ず検証する）
APP="$BUNDLE_DIR/macos/solo-eikaiwa.app"
DMG="$BUNDLE_DIR/dmg/solo-eikaiwa_${VERSION}_aarch64.dmg"
TARGZ="$BUNDLE_DIR/macos/solo-eikaiwa.app.tar.gz"
SIG="$TARGZ.sig"
for p in "$APP" "$DMG" "$TARGZ" "$SIG"; do
  [[ -e "$p" ]] || { echo "ERROR: 生成物がありません: $p（.sig 欠落なら TAURI_SIGNING_PRIVATE_KEY を確認）" >&2; exit 1; }
done
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl -a -t exec -vv "$APP"

# 7. dmg 自体の公証 + staple（Tauri は .app のみ staple するため dmg は手動で）
echo "-- dmg 公証（数分かかります）"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

# 8. latest.json 生成（signature は .sig の中身）
LATEST_JSON="$BUNDLE_DIR/latest.json"
SIG_CONTENT="$(cat "$SIG")" \
URL="https://github.com/btajp/solo-eikaiwa/releases/download/v${VERSION}/solo-eikaiwa.app.tar.gz" \
VERSION="$VERSION" PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
python3 - "$LATEST_JSON" <<'PY'
import json, os, sys
json.dump({
    "version": os.environ["VERSION"],
    "pub_date": os.environ["PUB_DATE"],
    "platforms": {"darwin-aarch64": {"signature": os.environ["SIG_CONTENT"], "url": os.environ["URL"]}},
}, open(sys.argv[1], "w"), indent=2)
PY

# 9. GitHub Release（draft で全アセットを揃えてから publish = latest.json とアセットの原子公開）
NOTES_FILE="$(mktemp)"
python3 - "$REPO_DIR/CHANGELOG.md" "$VERSION" > "$NOTES_FILE" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(rf"^## \[{re.escape(sys.argv[2])}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
print(m.group(1).strip() if m else "")
PY
gh release create "v$VERSION" --draft --title "v$VERSION" --notes-file "$NOTES_FILE" \
  "$DMG" "$TARGZ" "$LATEST_JSON"
gh release edit "v$VERSION" --draft=false
rm -f "$NOTES_FILE"
git -C "$REPO_DIR" fetch --tags

echo ""
echo "== リリース完了: https://github.com/btajp/solo-eikaiwa/releases/tag/v$VERSION =="
echo "事後スモーク:"
echo "  1. ブラウザで dmg を実ダウンロード → マウント → /Applications へコピー → ダブルクリックで警告なしに起動すること"
echo "  2. 旧バージョンのアプリを起動 → 更新ダイアログ → 1クリック更新 → 新バージョンで再起動すること"
```

- [ ] **Step 2: 構文チェックとテンプレート生成の動作確認**

Run: `bash -n scripts/release-desktop.sh && SOLO_EIKAIWA_RELEASE_ENV=/tmp/test-release.env ./scripts/release-desktop.sh 0.29.0; echo "exit=$?"`
Expected: テンプレート生成メッセージ + exit=1（env 未記入で正しく停止）

- [ ] **Step 3: Commit** `feat: 署名・公証・updater署名・GitHub Release を一括実行する release-desktop.sh`

### Task 6: E2E スパイク — ローカル updater E2E（ad-hoc・Apple 資格情報不要）

**Files:**
- Create: `desktop/e2e-updater/old.conf.json` / `desktop/e2e-updater/new.conf.json`（endpoint 差し替え overlay）
- Create: `desktop/e2e-updater/README.md`（手順の恒久記録）

**Interfaces:**
- Consumes: Task 1-5 の全成果物

- [ ] **Step 1: overlay 2つを作成**

`old.conf.json`（更新される側。バージョンは committed のまま）:

```json
{
  "plugins": {
    "updater": {
      "endpoints": ["http://127.0.0.1:8930/latest.json"],
      "dangerousInsecureTransportProtocol": true
    }
  }
}
```

`new.conf.json`（更新後になる側。updater artifacts も有効化）:

```json
{
  "version": "99.0.0",
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "endpoints": ["http://127.0.0.1:8930/latest.json"],
      "dangerousInsecureTransportProtocol": true
    }
  }
}
```

- [ ] **Step 2: E2E 実施**（手順を README.md にも書く）

```bash
cd desktop/src-tauri
# 1) 新バージョン（v99.0.0）をビルドして tar.gz + .sig を得る
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/solo-eikaiwa-updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
cargo tauri build --bundles app --config ../e2e-updater/new.conf.json
mkdir -p /tmp/solo-e2e && cp target/release/bundle/macos/solo-eikaiwa.app.tar.gz /tmp/solo-e2e/
SIG=$(cat target/release/bundle/macos/solo-eikaiwa.app.tar.gz.sig)
printf '{"version":"99.0.0","platforms":{"darwin-aarch64":{"signature":"%s","url":"http://127.0.0.1:8930/solo-eikaiwa.app.tar.gz"}}}' "$SIG" > /tmp/solo-e2e/latest.json
# 2) 旧バージョン（現行 version）をビルドして /Applications 相当に置く
cargo tauri build --bundles app --config ../e2e-updater/old.conf.json
rm -rf /tmp/solo-e2e-app && mkdir -p /tmp/solo-e2e-app
cp -R target/release/bundle/macos/solo-eikaiwa.app /tmp/solo-e2e-app/
# 3) 配信して起動
(cd /tmp/solo-e2e && python3 -m http.server 8930 &)
open /tmp/solo-e2e-app/solo-eikaiwa.app
```

Expected（すべて満たすこと）:
1. 起動時に更新ダイアログ（v99.0.0 が利用可能）が出る
2. 「更新する」→ DL → アプリが自動再起動する
3. 再起動後 `plutil -p /tmp/solo-e2e-app/solo-eikaiwa.app/Contents/Info.plist | grep ShortVersion` が `99.0.0`
4. 旧 sidecar が残っていない: `pgrep -fl solo-server` が新プロセスのみ（PID が入れ替わる）
5. 「今回はしない」を選んだ場合は何も起きず普通に使える（再起動で再度1回だけ聞かれる）

- [ ] **Step 3: 後始末** — `kill %1`（http.server）・`/tmp/solo-e2e*` 削除
- [ ] **Step 4: Commit** `test: updater実機E2E用のendpoint差し替えoverlayと手順書`

### Task 7: バージョン 0.29.0 へ bump + docs + CHANGELOG

**Files:**
- Modify: `app/package.json` / `desktop/src-tauri/Cargo.toml` / `desktop/src-tauri/tauri.conf.json`（version → 0.29.0）
- Modify: `README.md`（デスクトップ節: Gatekeeper 回避手順を削除し署名済み配布 + 自動更新の記述へ。「できること」に自動更新を1行）
- Modify: `desktop/README.md`（署名・リリース節を新設: release-desktop.sh / release.env / whisper-bin プレ署名の理由 / updater 鍵管理・バックアップ / E2E 手順への参照。TCC 節に「v0.29 で Developer ID 署名へ移行」の追記）
- Modify: `CHANGELOG.md`（v0.29.0 節）
- 確認: `site/index.html` に Gatekeeper 手順の記述があれば同様に更新

- [ ] **Step 1: version 3ファイル bump**（`cargo check` で Cargo.lock も追従させる）
- [ ] **Step 2: CHANGELOG v0.29.0 節**（要素: Developer ID 署名+公証で「このまま開く」不要に / 半自動アップデート / メニュー「アップデートを確認…」/ 注意: 署名変更でマイク許可が一度だけ再要求・v0.28 以前からは今回のみ手動 DL）
- [ ] **Step 3: README / desktop README / site 更新**
- [ ] **Step 4: 検証ゲート3種 + `cargo test --lib`** — Expected: すべて green
- [ ] **Step 5: Commit** `docs: v0.29.0 署名済み配布・自動アップデートのドキュメント一式（バージョンbump込み）`

### Task 8: 最終検証・レビュー

- [ ] 検証ゲート3種 + `cargo test --lib` + `cargo tauri build --bundles app`（ad-hoc・開発ビルドが従来どおり通ること = createUpdaterArtifacts overlay 未指定で .sig 生成に関わらず成功すること）
- [ ] whole-branch レビュー（多角レビュー + 検証）→ 指摘対応
- [ ] merge → （ユーザーの Apple 資格情報準備完了後）`./scripts/release-desktop.sh 0.29.0` → 実機スモーク（署名 E2E・TCC 請求元表示の実測）→ 台帳・メモリ更新

## ユーザー（人間）タスク（実装と独立・別ファイルで案内）

1. Developer ID Application 証明書の作成・Keychain 導入
2. App Store Connect API キー（.p8）の発行
3. `~/.config/solo-eikaiwa/release.env` の記入
4. `~/.tauri/solo-eikaiwa-updater.key` のバックアップ（紛失=自動更新チェーン永久喪失）
5. リリース後の実機確認（Gatekeeper 素通り・マイク許可の請求元表示・旧→新の自動更新）
