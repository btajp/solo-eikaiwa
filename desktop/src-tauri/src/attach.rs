//! アタッチ方式: ローカルサーバ（solo-eikaiwa本体）の生死・身元を確認し、
//! 生きていて本人であればメインウィンドウをそのURLへ向ける。
//!
//! Tauri Phase 2: 配布アプリは自前のサーバ（sidecar・[`crate::sidecar`]）を同梱するが、
//! 開発者のLaunchAgentデーモンが同じ127.0.0.1:3111で稼働中なら、それにアタッチしてsidecar
//! 起動を省略する（attach-first）。ただし別アプリ/別サービスがたまたま同じポートを掴んでいる
//! 事故を避けるため、health応答の`app`フィールドがsolo-eikaiwa本体であることを確認してから
//! navigateする（身元確認）。`SOLO_EIKAIWA_NO_ATTACH`が設定されていればattachを試みず、
//! 常に自前のsidecarを起動する（配布ユーザーは通常デーモンを持たないため実質常にこの経路）。

use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager, Url};
use ureq::Agent;

use crate::sidecar;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
/// 既存デーモンへのattach試行回数。配布版ではデーモンが存在しないケースが大半なため、
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
}

/// health応答のJSONボディが取得できればそのまま返す（内容は問わず、生死確認のみだったPhase1の
/// 挙動から拡張し、身元確認のためにボディを呼び出し元へ渡す）。
fn fetch_health_body(url: &str) -> Option<String> {
    let mut res = health_agent().get(url).call().ok()?;
    res.body_mut().read_to_string().ok()
}

/// health応答のJSONボディがsolo-eikaiwa本体のものかを純粋に判定する（ネットワーク非依存・テスト可能）。
/// 不正なJSON・`app`フィールド欠落・値の不一致はすべて「本体ではない」として扱う（fail-closed）。
fn identity_ok(body: &str) -> bool {
    serde_json::from_str::<HealthIdentity>(body)
        .map(|h| h.app.as_deref() == Some(EXPECTED_APP_ID))
        .unwrap_or(false)
}

/// 指定ポートのサーバが生きていて、かつsolo-eikaiwa本体だと確認できたか（1回分の判定）。
pub(crate) fn is_identified(port: u16) -> bool {
    fetch_health_body(&health_url(port)).is_some_and(|body| identity_ok(&body))
}

/// `SOLO_EIKAIWA_NO_ATTACH` が空でない値で設定されていればattachを試みない
/// （配布動作の実機検証・強制的に自前sidecarで起動させたい場合に使う）。
fn no_attach_forced() -> bool {
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

/// 既存デーモン（`sidecar::DEFAULT_PORT`）への身元確認つきattachを試みる。
/// `SOLO_EIKAIWA_NO_ATTACH`指定時は即falseを返す（sidecar起動へ委ねる）。
fn try_attach_to_existing(app: &AppHandle) -> bool {
    if no_attach_forced() {
        log::info!("attach: SOLO_EIKAIWA_NO_ATTACH set, skipping attach and going straight to own sidecar");
        return false;
    }
    for attempt in 1..=ATTACH_POLL_ATTEMPTS {
        if is_identified(sidecar::DEFAULT_PORT) {
            return navigate_to(app, sidecar::DEFAULT_PORT);
        }
        log::info!(
            "attach: no identified solo-eikaiwa server yet on {} (attempt {attempt}/{ATTACH_POLL_ATTEMPTS})",
            sidecar::DEFAULT_PORT,
        );
        std::thread::sleep(ATTACH_POLL_INTERVAL);
    }
    false
}

/// 起動時に呼ぶ: attach-first（身元確認つき）→ 失敗したら自前のsidecarを起動する。
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
#[tauri::command]
pub fn retry_attach(app: AppHandle) -> bool {
    if try_attach_to_existing(&app) {
        return true;
    }
    sidecar::spawn_and_attach(&app)
}

#[cfg(test)]
mod tests {
    use super::{args_have_poc_stt_flag, identity_ok, is_identified, target_url};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // 1テスト内で set/remove を完結させ、他テストとのプロセスグローバルenvの競合を避ける。
    #[test]
    fn target_url_switches_on_poc_env_var() {
        std::env::remove_var("SOLO_EIKAIWA_POC");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/");

        std::env::set_var("SOLO_EIKAIWA_POC", "stt");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/?poc=stt");

        std::env::set_var("SOLO_EIKAIWA_POC", "other");
        assert_eq!(target_url(3111), "http://127.0.0.1:3111/");

        std::env::remove_var("SOLO_EIKAIWA_POC");
    }

    #[test]
    fn target_url_uses_given_port() {
        std::env::remove_var("SOLO_EIKAIWA_POC");
        assert_eq!(target_url(3112), "http://127.0.0.1:3112/");
    }

    #[test]
    fn args_have_poc_stt_flag_detects_the_flag_anywhere_in_argv() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert!(args_have_poc_stt_flag(args(&["bin", "--poc=stt"])));
        assert!(args_have_poc_stt_flag(args(&["bin", "--foo", "--poc=stt"])));
        assert!(!args_have_poc_stt_flag(args(&["bin"])));
        assert!(!args_have_poc_stt_flag(args(&["bin", "--poc=other"])));
    }

    #[test]
    fn identity_ok_true_for_matching_app_field() {
        assert!(identity_ok(r#"{"app":"solo-eikaiwa","version":"0.28.0"}"#));
    }

    #[test]
    fn identity_ok_false_for_mismatched_app_field() {
        assert!(!identity_ok(r#"{"app":"some-other-app"}"#));
    }

    #[test]
    fn identity_ok_false_for_missing_app_field() {
        assert!(!identity_ok(r#"{"ok":true}"#));
    }

    #[test]
    fn identity_ok_false_for_malformed_json() {
        assert!(!identity_ok("not json"));
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
        let body = r#"{"app":"solo-eikaiwa","version":"0.28.0"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{}",
            body.len(),
            body,
        );
        let port = spawn_response_server(Box::leak(response.into_boxed_str()));
        assert!(is_identified(port));
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
        assert!(!is_identified(port));
    }

    #[test]
    fn is_identified_false_when_nothing_listens() {
        // バインドしてすぐ閉じ、誰も listen していないポートを作る。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local_addr").port();
        drop(listener);
        assert!(!is_identified(port));
    }
}
