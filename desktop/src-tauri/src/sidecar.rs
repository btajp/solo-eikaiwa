//! Tauri Phase 2: サーバをexternalBin（sidecar）として同梱し、自前で起動する経路。
//! [`crate::attach`] の「既存デーモンへのattach」が失敗した場合（配布版の大半のケース）に
//! ここへ落ちる: サーババイナリをspawn → env注入 → ヘルスポーリング（身元確認つき）→ navigate。
//! ポート競合（3111使用中）はサーバ側が`process.exit(1)`する設計（Task 1）に乗って検知し、
//! 3112へ1回だけフォールバックする。アプリ終了時は起動した子プロセスをkillする。

use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::attach;

/// サーバの既定ポート（LaunchAgentデーモン・sidecar共通）。
pub(crate) const DEFAULT_PORT: u16 = 3111;
/// `DEFAULT_PORT`が使用中だった場合に1回だけ試すフォールバック先。
const FALLBACK_PORT: u16 = 3112;
const CANDIDATE_PORTS: [u16; 2] = [DEFAULT_PORT, FALLBACK_PORT];

/// 自前spawn後、健康になるまで待つポーリング回数・間隔（DBオープン等の初回起動コストを見込む）。
const OWN_SIDECAR_POLL_ATTEMPTS: u32 = 20;
const OWN_SIDECAR_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// ログインシェルでの`$PATH`解決を待つ上限（壊れた.zshrc等で無限に待たないための保険）。
const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);

/// 起動したsidecarの子プロセスハンドル。アプリ終了時にkillするため`app.manage()`で保持する。
#[derive(Default)]
pub struct SidecarState(pub Mutex<Option<CommandChild>>);

/// アプリ終了イベント（`RunEvent::Exit`）から呼ぶ。起動中のsidecarがあれば終了させる。
pub fn kill_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let child = state.0.lock().unwrap().take();
    if let Some(child) = child {
        log::info!("sidecar: killing child process on app exit");
        let _ = child.kill();
    }
}

/// whisper-bin（同梱whisper-cli）を最優先にしつつ、ユーザーのログインシェルの`$PATH`
/// （claude/codexがbrew/npm/公式インストーラのどこに入っていても`Bun.which()`で解決できるように
/// するため）を土台にする。ログインシェルのPATHが取れなければプロセス継承分にフォールバックする
/// （劣化はするが安全）。
pub(crate) fn effective_path(whisper_bin_dir: &str, login_shell_path: Option<&str>, inherited_path: &str) -> String {
    let base = login_shell_path.filter(|p| !p.is_empty()).unwrap_or(inherited_path);
    if base.is_empty() {
        whisper_bin_dir.to_string()
    } else {
        format!("{whisper_bin_dir}:{base}")
    }
}

/// ある試行の後、次の候補ポートを試すべきかを判定する（純粋ロジック）。
/// 身元確認済みなら（呼び出し元がnavigateするので）これ以上試す必要はない。
/// プロセスが生きたまま応答が無い場合はリトライしても無意味なので諦める。
/// プロセスが既に終了していればポート競合の可能性が高いので次のポートを試す。
pub(crate) fn should_try_next_port(identified: bool, process_exited: bool) -> bool {
    !identified && process_exited
}

/// `zsh -lc 'echo -n "$PATH"'` でログインシェルの`$PATH`を取得する
/// （`scripts/daemon-server.sh`と同じ狙い: GUIから起動したTauriアプリは
/// `/usr/bin:/bin:/usr/sbin:/sbin`程度の最小PATHしか継承しないため、brew/npm/公式インストーラの
/// どこに入れたか分からないclaude/codexを解決できるようにする）。タイムアウト付きで、
/// 失敗/タイムアウト時はNoneを返す（呼び出し元は継承PATHにフォールバックする）。
fn capture_login_shell_path() -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = std::process::Command::new("/bin/zsh")
            .args(["-lc", "echo -n \"$PATH\""])
            .output();
        let _ = tx.send(result);
    });

    match rx.recv_timeout(LOGIN_SHELL_PATH_TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => {
            let path = String::from_utf8(output.stdout).ok()?;
            let path = path.trim();
            (!path.is_empty()).then(|| path.to_string())
        }
        Ok(Ok(output)) => {
            log::warn!("sidecar: login shell PATH capture exited non-zero (code {:?})", output.status.code());
            None
        }
        Ok(Err(e)) => {
            log::warn!("sidecar: login shell PATH capture failed to run: {e}");
            None
        }
        Err(_) => {
            log::warn!("sidecar: login shell PATH capture timed out; falling back to inherited PATH");
            None
        }
    }
}

fn timestamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown-time".to_string())
}

/// `CommandEvent`を1行のログテキストに整形する（stdout/stderr/エラー/終了の4種）。純粋関数。
/// `#[non_exhaustive]`な列挙なので将来の変種は無視する（ログが1行減るだけで安全側に倒れる）。
pub(crate) fn format_command_event(event: &CommandEvent) -> Option<String> {
    match event {
        CommandEvent::Stdout(bytes) => Some(format!("[stdout] {}", String::from_utf8_lossy(bytes).trim_end())),
        CommandEvent::Stderr(bytes) => Some(format!("[stderr] {}", String::from_utf8_lossy(bytes).trim_end())),
        CommandEvent::Error(err) => Some(format!("[error] {err}")),
        CommandEvent::Terminated(payload) => Some(format!(
            "[terminated] code={:?} signal={:?}",
            payload.code, payload.signal,
        )),
        _ => None,
    }
}

fn append_log_line(file: &mut Option<std::fs::File>, line: &str) {
    let Some(f) = file.as_mut() else { return };
    let _ = writeln!(f, "{} {}", timestamp(), line);
    let _ = f.flush();
}

/// solo-serverをsidecarとして指定ポートで起動する。成功したら（子プロセスハンドル,
/// プロセスが既に終了したかを示すフラグ）を返す。フラグは非同期に更新される
/// （ログ読み取りタスクが`Terminated`イベントを見た時点でtrueにする)ため、呼び出し元は
/// ヘルスポーリングの合間ではなく完了後に読む想定。
fn spawn_solo_server(
    app: &AppHandle,
    port: u16,
    resources_dir: &Path,
    data_dir: &Path,
    path_env: &str,
    log_path: &Path,
) -> Option<(CommandChild, Arc<AtomicBool>)> {
    let command = match app.shell().sidecar("solo-server") {
        Ok(cmd) => cmd,
        Err(e) => {
            log::error!("sidecar: failed to resolve solo-server binary: {e}");
            return None;
        }
    };
    let command = command
        .env("SOLO_EIKAIWA_RESOURCES_DIR", resources_dir.display().to_string())
        .env("SOLO_EIKAIWA_DATA_DIR", data_dir.display().to_string())
        .env("SOLO_EIKAIWA_PORT", port.to_string())
        .env("PATH", path_env);

    let (mut rx, child) = match command.spawn() {
        Ok(pair) => pair,
        Err(e) => {
            log::error!("sidecar: failed to spawn solo-server on port {port}: {e}");
            return None;
        }
    };

    let exited = Arc::new(AtomicBool::new(false));
    let exited_writer = exited.clone();
    let log_path = log_path.to_path_buf();
    tauri::async_runtime::spawn(async move {
        let mut log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
        if log_file.is_none() {
            log::error!("sidecar: failed to open log file {log_path:?}; sidecar output will not be persisted");
        }
        while let Some(event) = rx.recv().await {
            if let Some(line) = format_command_event(&event) {
                append_log_line(&mut log_file, &line);
            }
            if matches!(event, CommandEvent::Terminated(_)) {
                exited_writer.store(true, Ordering::SeqCst);
            }
        }
    });

    Some((child, exited))
}

/// attach失敗後（または`SOLO_EIKAIWA_NO_ATTACH`指定時）に呼ぶ: 自前のsidecarを起動し、
/// ヘルスチェック（身元確認つき）が通ったらnavigateする。戻り値はnavigateまで成功したか
/// （`retry_attach`コマンドの戻り値・フォールバックページのボタン結果に使う）。
pub fn spawn_and_attach(app: &AppHandle) -> bool {
    let resources_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("sidecar: failed to resolve resource_dir: {e}");
            return false;
        }
    };
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("sidecar: failed to resolve app_data_dir: {e}");
            return false;
        }
    };
    let logs_dir = data_dir.join("logs");
    if let Err(e) = std::fs::create_dir_all(&logs_dir) {
        log::error!("sidecar: failed to create logs dir {logs_dir:?}: {e}");
        return false;
    }
    let log_path = logs_dir.join("sidecar.log");

    let whisper_bin_dir = resources_dir.join("whisper-bin");
    let login_path = capture_login_shell_path();
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let path_env = effective_path(&whisper_bin_dir.display().to_string(), login_path.as_deref(), &inherited_path);

    for &port in CANDIDATE_PORTS.iter() {
        log::info!("sidecar: spawning solo-server on port {port}");
        let Some((child, exited)) = spawn_solo_server(app, port, &resources_dir, &data_dir, &path_env, &log_path) else {
            // 起動自体に失敗（バイナリ欠落等）。ポートを変えても無意味なので諦める。
            break;
        };

        if let Some(state) = app.try_state::<SidecarState>() {
            let previous = state.0.lock().unwrap().replace(child);
            if let Some(previous) = previous {
                // 前のポートの子が万一残っていれば片付ける（通常は既に自己終了しているはず）。
                let _ = previous.kill();
            }
        }

        let mut identified = false;
        for attempt in 1..=OWN_SIDECAR_POLL_ATTEMPTS {
            if attach::is_identified(port) {
                identified = true;
                break;
            }
            // ポート競合（EADDRINUSE）等でプロセスが即座に終了した場合、まだ生きているかのように
            // 残り試行を最後まで待つのは無駄（起動には10秒近くかかる設定）。exitedを見て早期に諦め、
            // 次の候補ポートへ進む。
            if exited.load(Ordering::SeqCst) {
                log::warn!("sidecar: solo-server on port {port} exited before becoming healthy (attempt {attempt})");
                break;
            }
            log::info!(
                "sidecar: waiting for solo-server on port {port} (attempt {attempt}/{OWN_SIDECAR_POLL_ATTEMPTS})",
            );
            std::thread::sleep(OWN_SIDECAR_POLL_INTERVAL);
        }

        if identified {
            return attach::navigate_to(app, port);
        }

        if should_try_next_port(identified, exited.load(Ordering::SeqCst)) {
            log::warn!("sidecar: solo-server on port {port} exited quickly (likely port conflict); trying next port");
            continue;
        }

        log::error!(
            "sidecar: solo-server on port {port} did not become healthy in time; giving up (see {log_path:?})",
        );
        break;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::{effective_path, format_command_event, should_try_next_port};
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    #[test]
    fn effective_path_prefers_login_shell_path() {
        assert_eq!(
            effective_path("/a/whisper-bin", Some("/usr/bin:/bin"), "/x"),
            "/a/whisper-bin:/usr/bin:/bin",
        );
    }

    #[test]
    fn effective_path_falls_back_to_inherited_when_login_shell_path_missing() {
        assert_eq!(
            effective_path("/a/whisper-bin", None, "/x:/y"),
            "/a/whisper-bin:/x:/y",
        );
    }

    #[test]
    fn effective_path_falls_back_when_login_shell_path_is_empty_string() {
        assert_eq!(
            effective_path("/a/whisper-bin", Some(""), "/x"),
            "/a/whisper-bin:/x",
        );
    }

    #[test]
    fn effective_path_handles_both_missing() {
        assert_eq!(effective_path("/a/whisper-bin", None, ""), "/a/whisper-bin");
    }

    #[test]
    fn should_try_next_port_only_when_not_identified_and_process_exited() {
        assert!(!should_try_next_port(true, true));
        assert!(!should_try_next_port(true, false));
        assert!(!should_try_next_port(false, false));
        assert!(should_try_next_port(false, true));
    }

    #[test]
    fn format_command_event_formats_stdout_stderr_error_terminated() {
        assert_eq!(
            format_command_event(&CommandEvent::Stdout(b"hello\n".to_vec())).unwrap(),
            "[stdout] hello",
        );
        assert_eq!(
            format_command_event(&CommandEvent::Stderr(b"oops\n".to_vec())).unwrap(),
            "[stderr] oops",
        );
        assert_eq!(
            format_command_event(&CommandEvent::Error("boom".to_string())).unwrap(),
            "[error] boom",
        );
        assert_eq!(
            format_command_event(&CommandEvent::Terminated(TerminatedPayload { code: Some(1), signal: None })).unwrap(),
            "[terminated] code=Some(1) signal=None",
        );
    }
}
