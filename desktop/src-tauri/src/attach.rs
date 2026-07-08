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
    let Ok(url) = Url::parse(SERVER_URL) else {
        return false;
    };
    window.navigate(url).is_ok()
}

/// 起動時に呼ぶ: バックグラウンドスレッドでサーバ起動を数回リトライしながら待つ。
/// 全滅した場合は同梱のフォールバックページ（案内+再試行ボタン）が表示されたままになる。
pub fn spawn_initial_attach(app: AppHandle) {
    std::thread::spawn(move || {
        for _ in 0..POLL_ATTEMPTS {
            if try_attach(&app) {
                return;
            }
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
    use super::is_healthy;
    use std::io::{Read, Write};
    use std::net::TcpListener;

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
