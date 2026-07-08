//! アタッチ方式: ローカルサーバ（127.0.0.1:3111・solo-eikaiwa本体）の生死を確認し、
//! 生きていればメインウィンドウをそのURLへ向ける。Phase 1 ではサーバのsidecar化は行わず、
//! 既存のLaunchAgentデーモン/手動起動を前提に「見に行くだけ」の薄いシェルとする。

use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use ureq::Agent;

const SERVER_URL: &str = "http://127.0.0.1:3111/";
const HEALTH_URL: &str = "http://127.0.0.1:3111/api/health";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_ATTEMPTS: u32 = 5;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const MAIN_WINDOW_LABEL: &str = "main";

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

fn target_url() -> String {
    if poc_stt_requested() {
        format!("{SERVER_URL}?poc=stt")
    } else {
        SERVER_URL.to_string()
    }
}

fn health_agent() -> Agent {
    Agent::config_builder()
        .timeout_global(Some(HEALTH_TIMEOUT))
        .build()
        .into()
}

/// 指定URLがHTTP応答を返すかどうかを1回だけ確認する（内容は問わない。呼び出し元の
/// タイムアウトに乗せて短時間で判定するための純粋なロジックとしてテスト可能に分離してある）。
fn is_healthy(url: &str) -> bool {
    health_agent().get(url).call().is_ok()
}

/// サーバが生きていれば、メインウィンドウを実アプリのURLへ切り替える。
/// 戻り値はアタッチできたかどうか（呼び出し元の再試行UIに使う）。
fn try_attach(app: &AppHandle) -> bool {
    if !is_healthy(HEALTH_URL) {
        return false;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return false;
    };
    let Ok(url) = Url::parse(&target_url()) else {
        return false;
    };
    window.navigate(url).is_ok()
}

/// 起動時に呼ぶ: バックグラウンドスレッドでサーバ起動を数回リトライしながら待つ。
/// 全滅した場合は同梱のフォールバックページ（案内+再試行ボタン）が表示されたままになる。
pub fn spawn_initial_attach(app: AppHandle) {
    std::thread::spawn(move || {
        for attempt in 1..=POLL_ATTEMPTS {
            if try_attach(&app) {
                return;
            }
            log::warn!("attach: server not reachable yet (attempt {attempt}/{POLL_ATTEMPTS})");
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// フォールバックページの「再試行」ボタンから呼ばれるTauriコマンド。
#[tauri::command]
pub fn retry_attach(app: AppHandle) -> bool {
    try_attach(&app)
}

#[cfg(test)]
mod tests {
    use super::{args_have_poc_stt_flag, is_healthy, target_url, SERVER_URL};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    // 1テスト内で set/remove を完結させ、他テストとのプロセスグローバルenvの競合を避ける。
    #[test]
    fn target_url_switches_on_poc_env_var() {
        std::env::remove_var("SOLO_EIKAIWA_POC");
        assert_eq!(target_url(), SERVER_URL);

        std::env::set_var("SOLO_EIKAIWA_POC", "stt");
        assert_eq!(target_url(), format!("{SERVER_URL}?poc=stt"));

        std::env::set_var("SOLO_EIKAIWA_POC", "other");
        assert_eq!(target_url(), SERVER_URL);

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

    /// ローカルに1回だけ「HTTP/1.1 200 OK」を返す使い捨てサーバを立て、そのURLを渡す。
    fn spawn_ok_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local_addr");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 512];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn is_healthy_true_when_server_responds() {
        let url = spawn_ok_server();
        assert!(is_healthy(&url));
    }

    #[test]
    fn is_healthy_false_when_nothing_listens() {
        // バインドしてすぐ閉じ、誰も listen していないポートを作る。
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local_addr");
        drop(listener);
        assert!(!is_healthy(&format!("http://{addr}/")));
    }
}
