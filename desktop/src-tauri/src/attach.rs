//! アタッチ方式: ローカルサーバ（solo-eikaiwa本体）の生死・身元を確認し、
//! 生きていて本人であればメインウィンドウをそのURLへ向ける。
//!
//! Tauri Phase 2: 配布アプリは自前のサーバ（sidecar・[`crate::sidecar`]）を同梱するが、
//! 過去の起動でorphan化した同一ビルドのsidecarが同じデータ領域を使っている場合だけ再利用する。
//! healthの`app`だけでは開発サーバ・旧版・別データ領域を区別できないため、protocol・アプリ版・
//! build ID・正規化データ領域ID・永続instance IDをすべて照合する（fail-closed）。

use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Url};
use ureq::Agent;

use crate::sidecar;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
/// 検証済みorphanへのattach試行回数。通常はorphanが存在しないため、
/// ここで長く待つと全ユーザーの起動が毎回遅くなる。短く見切ってsidecar起動へ進む。
const ATTACH_POLL_ATTEMPTS: u32 = 2;
const ATTACH_POLL_INTERVAL: Duration = Duration::from_millis(300);
const MAIN_WINDOW_LABEL: &str = "main";
/// solo-eikaiwa本体を示す識別子（app/server/health.tsが返す固定値と一致させる）。
const EXPECTED_APP_ID: &str = "solo-eikaiwa";

/// Task 3（録音→STT PoC）専用のdevフック: 環境変数 `SOLO_EIKAIWA_POC=stt` または
/// CLI引数 `--poc=stt` のどちらかが指定されていれば通常の `/` ではなく dev専用PoCページ
/// （`?poc=stt`）へ向ける。
///
/// 2経路ある理由: 直接exec（`.app`内バイナリを直接起動）はenvを引き継ぐがTCC
/// （マイク権限ダイアログ）の請求元が起動元のターミナルに誤帰属することが実機検証で判明した。
/// `open -na App --args --poc=stt` はLaunchServices経由の起動のためTCCの請求元が正しく
/// アプリ本体に帰属する一方、envは引き継がない。そのため argv 経由を正規の起動手段とし、
/// env var は（デバッグ時の直接exec向けに）互換性のため残す。
fn args_have_poc_stt_flag(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|a| a == "--poc=stt")
}

fn poc_stt_requested() -> bool {
    args_have_poc_stt_flag(std::env::args()) || std::env::var("SOLO_EIKAIWA_POC").as_deref() == Ok("stt")
}

fn server_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

fn health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/health")
}

fn target_url(port: u16) -> String {
    if poc_stt_requested() {
        format!("{}?poc=stt", server_url(port))
    } else {
        server_url(port)
    }
}

fn health_agent() -> Agent {
    Agent::config_builder()
        .timeout_global(Some(HEALTH_TIMEOUT))
        .build()
        .into()
}

#[derive(Debug, Deserialize)]
struct HealthIdentity {
    app: Option<String>,
    version: Option<String>,
    sidecar: Option<HealthSidecarIdentity>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthSidecarIdentity {
    protocol: Option<u8>,
    build_id: Option<String>,
    data_root_id: Option<String>,
    instance_id: Option<String>,
}

/// Desktopが正規sidecarへ要求する識別情報。起動ごとのnonceではなく永続instance IDを使うため、
/// Force Quit後の正当なorphanは再利用できる一方、旧版・別データ領域・開発サーバは拒否できる。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExpectedSidecarIdentity {
    pub(crate) app_version: String,
    pub(crate) protocol: u8,
    pub(crate) build_id: String,
    pub(crate) data_root_id: String,
    pub(crate) instance_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdentityStatus {
    Match,
    Stale,
    Foreign,
    Unavailable,
}

/// 分類（[`IdentityStatus`]）に加えて、Stale応答が自分のdata_root_id・instance_idを名乗る
/// 「自分が過去に起動した旧sidecar」かどうかを添えた判定結果。
///
/// 自動更新はアプリ本体（.appバンドル）を差し替えるだけで走行中のsidecarを差し替えないため、
/// attach再利用中（子プロセスとして持っていない）の旧sidecarは更新後もattach拒否（Stale）される
/// だけで生き残り、既定ポートで旧バージョンの/api/healthを返し続ける（#270で実測）。
/// 呼び出し元（`sidecar::spawn_and_attach`）が自分の過去プロセスに限って回収できるよう、
/// 判定材料をここで渡す。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct IdentityReport {
    pub(crate) status: IdentityStatus,
    /// `status == Stale` かつ data_root_id・instance_id の両方が自分のものと一致する場合のみtrue。
    /// Foreign・Match・sidecarフィールド無し（開発サーバ等）では必ずfalse。
    pub(crate) stale_own_sidecar: bool,
}

impl IdentityReport {
    fn plain(status: IdentityStatus) -> Self {
        Self { status, stale_own_sidecar: false }
    }
}

/// health応答のJSONボディが取得できればそのまま返す（内容は問わず、生死確認のみだったPhase1の
/// 挙動から拡張し、身元確認のためにボディを呼び出し元へ渡す）。
fn fetch_health_body(url: &str) -> Option<String> {
    let mut res = health_agent().get(url).call().ok()?;
    res.body_mut().read_to_string().ok()
}

/// health応答を、正規sidecar・旧版/別データ領域・無関係な応答へ分類する純粋関数。
/// solo-eikaiwaを名乗る旧healthも安全側に倒してStaleとし、app不一致・壊れたJSONはForeignとする。
/// Staleのうち自分のdata_root_id・instance_idを名乗るもの（=自分の過去sidecar）は
/// `stale_own_sidecar` として区別する（#270の回収対象の判定材料）。
fn identity_report(body: &str, expected: &ExpectedSidecarIdentity) -> IdentityReport {
    let Ok(health) = serde_json::from_str::<HealthIdentity>(body) else {
        return IdentityReport::plain(IdentityStatus::Foreign);
    };
    if health.app.as_deref() != Some(EXPECTED_APP_ID) {
        return IdentityReport::plain(IdentityStatus::Foreign);
    }
    let Some(sidecar) = health.sidecar else {
        return IdentityReport::plain(IdentityStatus::Stale);
    };
    let same_data_root_and_instance = sidecar.data_root_id.as_deref()
        == Some(expected.data_root_id.as_str())
        && sidecar.instance_id.as_deref() == Some(expected.instance_id.as_str());
    let matches = health.version.as_deref() == Some(expected.app_version.as_str())
        && sidecar.protocol == Some(expected.protocol)
        && sidecar.build_id.as_deref() == Some(expected.build_id.as_str())
        && same_data_root_and_instance;
    if matches {
        IdentityReport::plain(IdentityStatus::Match)
    } else {
        IdentityReport { status: IdentityStatus::Stale, stale_own_sidecar: same_data_root_and_instance }
    }
}

/// 指定ポートを1回だけ調べ、接続不能も含めて分類する（回収判定つき）。
pub(crate) fn probe_identity_report(port: u16, expected: &ExpectedSidecarIdentity) -> IdentityReport {
    fetch_health_body(&health_url(port))
        .map(|body| identity_report(&body, expected))
        .unwrap_or_else(|| IdentityReport::plain(IdentityStatus::Unavailable))
}

/// 指定ポートを1回だけ調べ、接続不能も含めて分類する。
pub(crate) fn probe_identity(port: u16, expected: &ExpectedSidecarIdentity) -> IdentityStatus {
    probe_identity_report(port, expected).status
}

/// 指定ポートが期待する正規sidecarか。
pub(crate) fn is_identified(port: u16, expected: &ExpectedSidecarIdentity) -> bool {
    probe_identity(port, expected) == IdentityStatus::Match
}

/// `SOLO_EIKAIWA_NO_ATTACH` が空でない値で設定されていればattachを試みない
/// （配布動作の実機検証・強制的に自前sidecarで起動させたい場合に使う）。
/// `sidecar::spawn_and_attach`も、NO_ATTACH時に既存プロセスへ誤ってattachしてしまわないための
/// ガード（後述）でこの値を参照するため`pub(crate)`にしている。
pub(crate) fn no_attach_forced() -> bool {
    std::env::var("SOLO_EIKAIWA_NO_ATTACH")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

/// メインウィンドウを指定ポートの実アプリURLへ切り替える。
pub(crate) fn navigate_to(app: &AppHandle, port: u16) -> bool {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };
    let Ok(url) = Url::parse(&target_url(port)) else {
        return false;
    };
    window.navigate(url).is_ok()
}

/// Force Quit等でorphan化した過去のsidecarへの完全な身元確認つきattachを試みる。
/// `sidecar::CANDIDATE_PORTS`の順に全候補をチェックする: 既定ポートが別プロセスに
/// 使われていて過去のsidecarが別候補でorphan化しているケースでも、正規の終了を経ずに
/// 起動し直すたびに新しい自前sidecarを積み上げてしまわないよう、既に生きている自分の
/// sidecarを見つけ次第再利用する。`SOLO_EIKAIWA_NO_ATTACH`指定時は即falseを返す
/// （sidecar起動へ委ねる）。
fn try_attach_to_existing(app: &AppHandle) -> bool {
    if no_attach_forced() {
        log::info!("attach: SOLO_EIKAIWA_NO_ATTACH set, skipping attach and going straight to own sidecar");
        return false;
    }
    let expected = match sidecar::expected_identity(app) {
        Ok(identity) => identity,
        Err(e) => {
            log::error!("attach: failed to prepare sidecar identity: {e}");
            sidecar::note_startup_status(app, sidecar::StartupStatus::InternalError);
            return false;
        }
    };
    for attempt in 1..=ATTACH_POLL_ATTEMPTS {
        for &port in sidecar::CANDIDATE_PORTS.iter() {
            match probe_identity(port, &expected) {
                IdentityStatus::Match => {
                    let navigated = navigate_to(app, port);
                    sidecar::note_startup_status(
                        app,
                        if navigated { sidecar::StartupStatus::Ready } else { sidecar::StartupStatus::InternalError },
                    );
                    return navigated;
                }
                IdentityStatus::Stale => {
                    sidecar::note_startup_status(app, sidecar::StartupStatus::StaleSidecar);
                    log::warn!("attach: incompatible or stale solo-eikaiwa sidecar on port {port}; refusing attach");
                }
                IdentityStatus::Foreign => {
                    sidecar::note_startup_status(app, sidecar::StartupStatus::PortOccupied);
                    log::warn!("attach: port {port} answered with a foreign health response; refusing attach");
                }
                IdentityStatus::Unavailable => {}
            }
        }
        log::info!(
            "attach: no identified solo-eikaiwa server yet on any candidate port (attempt {attempt}/{ATTACH_POLL_ATTEMPTS})",
        );
        std::thread::sleep(ATTACH_POLL_INTERVAL);
    }
    false
}

/// 起動時に呼ぶ: 検証済みorphanの再利用 → 失敗したら自前のsidecarを起動する。
/// 全滅した場合は同梱のフォールバックページ（案内+再試行ボタン）が表示されたままになる。
pub fn spawn_initial_attach(app: AppHandle) {
    std::thread::spawn(move || {
        if try_attach_to_existing(&app) {
            return;
        }
        sidecar::spawn_and_attach(&app);
    });
}

/// フォールバックページの「再試行」ボタンから呼ばれるTauriコマンド。
///
/// `async fn`にしているのは飾りではない: 同期コマンドはWKWebViewのIPCメッセージハンドラ
/// （＝メインスレッド）上でインライン実行される（tauri-macros 2.6.3の`body_blocking`が
/// `$path(...)`を直接呼ぶだけの生成コードであることをソースで確認済み）。この内部で行う
/// ネットワーク呼び出し・`thread::sleep`によるポーリング（最悪ケースでポート2つ分＝数十秒）を
/// メインスレッドでブロックすると、その間ウィンドウの移動やCmd+Qすら効かなくなる。
/// `spawn_blocking`で専用スレッドプールへ逃がし、メインスレッドは即座に解放する。
#[tauri::command]
pub async fn retry_attach(app: AppHandle) -> bool {
    sidecar::reset_startup_status(&app);
    tauri::async_runtime::spawn_blocking(move || {
        if try_attach_to_existing(&app) {
            return true;
        }
        sidecar::spawn_and_attach(&app)
    })
    .await
    .unwrap_or(false)
}

/// フォールバック画面が、旧sidecarと一般的なポート占有を区別して案内するための状態取得。
#[tauri::command]
pub fn startup_status(app: AppHandle) -> sidecar::StartupStatus {
    sidecar::startup_status(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        args_have_poc_stt_flag, identity_report, is_identified, probe_identity,
        probe_identity_report, target_url, ExpectedSidecarIdentity, IdentityStatus,
    };
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    /// 分類のみを見る既存テスト向けの薄いラッパ（本体は`identity_report`に一本化済み）。
    fn identity_status(body: &str, expected: &ExpectedSidecarIdentity) -> IdentityStatus {
        identity_report(body, expected).status
    }

    /// `retry_attach`が`async fn`+`spawn_blocking`で実装されている理由そのものを検証する
    /// 回帰テスト: 同期コマンド（tauri-macrosの`body_blocking`）は`$path(...)`を
    /// 呼び出し元のスレッド（WKWebViewのIPCメッセージハンドラ＝メインスレッド）上でインライン
    /// 実行するため、内部の重い同期処理（ネットワーク呼び出し・複数秒のポーリング）でUI全体を
    /// フリーズさせてしまう。`spawn_blocking`は専用スレッドプールへ即座に処理を逃がし、
    /// 呼び出し元をブロックしないことをここで確認する（ソースで確認済みの`tauri::async_runtime`
    /// の実装契約を、実際に動かして裏取りする）。
    #[test]
    fn spawn_blocking_offloads_slow_work_without_blocking_the_caller() {
        let start = Instant::now();
        let handle = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(300));
            true
        });
        // spawn_blocking自体は即座にJoinHandleを返すはず（呼び出し元をブロックしない）。
        assert!(start.elapsed() < Duration::from_millis(100));
        let result = tauri::async_runtime::block_on(handle).unwrap();
        assert!(result);
        assert!(start.elapsed() >= Duration::from_millis(300));
    }

    // 1テスト内で set/remove を完結させ、他テストとのプロセスグローバルenvの競合を避ける。
    // target_url_uses_given_port を独立テストにすると、cargo test の並行実行で本テストの
    // set_var/remove_var と競合しフレークする（素のcargo testで300回中37回失敗を実測）ため、
    // SOLO_EIKAIWA_POC を触るアサーションは全てこの1テストにまとめている。
    #[test]
    fn target_url_switches_on_poc_env_var() {
        std::env::remove_var("SOLO_EIKAIWA_POC");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/");
        assert_eq!(target_url(3112), "http://127.0.0.1:3112/");

        std::env::set_var("SOLO_EIKAIWA_POC", "stt");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/?poc=stt");

        std::env::set_var("SOLO_EIKAIWA_POC", "other");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/");

        std::env::remove_var("SOLO_EIKAIWA_POC");
    }

    #[test]
    fn args_have_poc_stt_flag_detects_the_flag_anywhere_in_argv() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert!(args_have_poc_stt_flag(args(&["bin", "--poc=stt"])));
        assert!(args_have_poc_stt_flag(args(&["bin", "--foo", "--poc=stt"])));
        assert!(!args_have_poc_stt_flag(args(&["bin"])));
        assert!(!args_have_poc_stt_flag(args(&["bin", "--poc=other"])));
    }

    fn expected_identity() -> ExpectedSidecarIdentity {
        ExpectedSidecarIdentity {
            app_version: "0.29.0".to_string(),
            protocol: 1,
            build_id: "com.local.solo-eikaiwa.desktop@0.29.0".to_string(),
            data_root_id: "root-a".to_string(),
            instance_id: "instance-a".to_string(),
        }
    }

    #[test]
    fn identity_status_matches_only_the_complete_expected_handshake() {
        let body = r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        assert_eq!(identity_status(body, &expected_identity()), IdentityStatus::Match);
    }

    #[test]
    fn identity_status_rejects_stale_version_build_data_root_and_instance() {
        for body in [
            r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-a","instanceId":"instance-a"}}"#,
            r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"other-build","dataRootId":"root-a","instanceId":"instance-a"}}"#,
            r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-b","instanceId":"instance-a"}}"#,
            r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-a","instanceId":"instance-b"}}"#,
            r#"{"app":"solo-eikaiwa","version":"0.29.0"}"#,
        ] {
            assert_eq!(identity_status(body, &expected_identity()), IdentityStatus::Stale);
        }
    }

    #[test]
    fn identity_report_marks_own_stale_sidecar_for_matching_data_root_and_instance() {
        // 旧バージョン（version・buildId不一致）だがdata_root_id・instance_idは自分
        // = 自分が過去に起動した旧sidecar。回収候補（stale_own_sidecar）として報告する。
        let old_own = r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"old-build","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        let report = identity_report(old_own, &expected_identity());
        assert_eq!(report.status, IdentityStatus::Stale);
        assert!(report.stale_own_sidecar);
    }

    #[test]
    fn identity_report_never_marks_other_data_roots_instances_or_foreign_as_own() {
        for body in [
            // data_root_idが別（別データ領域のsidecar）
            r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"old-build","dataRootId":"root-b","instanceId":"instance-a"}}"#,
            // instance_idが別（別インストールのsidecar）
            r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"old-build","dataRootId":"root-a","instanceId":"instance-b"}}"#,
            // sidecarフィールド無し（開発サーバ・旧health）
            r#"{"app":"solo-eikaiwa","version":"0.28.0"}"#,
        ] {
            let report = identity_report(body, &expected_identity());
            assert_eq!(report.status, IdentityStatus::Stale, "body: {body}");
            assert!(!report.stale_own_sidecar, "body: {body}");
        }
        // Foreign・Matchはそもそも回収対象ではない。
        assert!(!identity_report(r#"{"app":"other-app"}"#, &expected_identity()).stale_own_sidecar);
        let matching = r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        let report = identity_report(matching, &expected_identity());
        assert_eq!(report.status, IdentityStatus::Match);
        assert!(!report.stale_own_sidecar);
    }

    #[test]
    fn identity_status_distinguishes_foreign_or_fake_health() {
        assert_eq!(identity_status(r#"{"app":"some-other-app"}"#, &expected_identity()), IdentityStatus::Foreign);
        assert_eq!(identity_status(r#"{"ok":true}"#, &expected_identity()), IdentityStatus::Foreign);
        assert_eq!(identity_status("not json", &expected_identity()), IdentityStatus::Foreign);
    }

    /// ローカルに1回だけ固定の応答を返す使い捨てサーバを立て、その待受ポートを返す。
    fn spawn_response_server(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        port
    }

    #[test]
    fn is_identified_true_when_server_returns_matching_identity() {
        let body = r#"{"app":"solo-eikaiwa","version":"0.29.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.29.0","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        assert!(is_identified(port, &expected_identity()));
    }

    #[test]
    fn is_identified_false_when_response_lacks_identity() {
        let body = r#"{"ok":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        assert!(!is_identified(port, &expected_identity()));
    }

    #[test]
    fn probe_identity_classifies_old_sidecar_over_real_http_as_stale() {
        let body = r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.28.0","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        assert_eq!(probe_identity(port, &expected_identity()), IdentityStatus::Stale);
    }

    #[test]
    fn probe_identity_report_flags_old_own_sidecar_over_real_http() {
        // 自動更新後に残った自分の旧sidecar（#270の実測パターン）: attachはStale拒否しつつ、
        // 回収候補であることをsidecar側へ伝える。
        let body = r#"{"app":"solo-eikaiwa","version":"0.28.0","sidecar":{"protocol":1,"buildId":"com.local.solo-eikaiwa.desktop@0.28.0","dataRootId":"root-a","instanceId":"instance-a"}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        let report = probe_identity_report(port, &expected_identity());
        assert_eq!(report.status, IdentityStatus::Stale);
        assert!(report.stale_own_sidecar);
    }

    #[test]
    fn probe_identity_classifies_fake_health_over_real_http_as_foreign() {
        let body = r#"{"app":"other-app","version":"0.29.0"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        assert_eq!(probe_identity(port, &expected_identity()), IdentityStatus::Foreign);
    }

    #[test]
    fn is_identified_false_when_nothing_listens() {
        // バインドしてすぐ閉じ、誰も listen していないポートを作る。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);
        assert!(!is_identified(port, &expected_identity()));
    }
}
