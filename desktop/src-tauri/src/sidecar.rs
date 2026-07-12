//! Tauri Phase 2: サーバをexternalBin（sidecar）として同梱し、自前で起動する経路。
//! [`crate::attach`] の「検証済みorphan再利用」が成立しなかった場合に
//! ここへ落ちる: サーババイナリをspawn → env注入 → ヘルスポーリング（身元確認つき）→ navigate。
//! ポート競合はサーバ側が`process.exit(1)`する設計（Task 1）に乗って検知し、
//! 複数の予約済み候補へ順番にフォールバックする。アプリ終了時は起動した子プロセスをkillする。

use std::fmt::Write as _;
use std::io::Write as _;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::attach;
use crate::diagnostic_log::RotatingLog;

/// サーバの既定ポート（LaunchAgentデーモン・sidecar共通）。
pub(crate) const DEFAULT_PORT: u16 = 3111;
/// ブラウザ版や開発サーバとの併用時にもsidecarを起動できる予約済み候補。
/// attach側でも全候補を使い、Force Quit等でorphan化したsidecarを再利用する。
pub(crate) const CANDIDATE_PORTS: [u16; 4] = [DEFAULT_PORT, 3112, 3113, 3114];

/// 自前spawn後、健康になるまで待つポーリング回数・間隔（DBオープン等の初回起動コストを見込む）。
const OWN_SIDECAR_POLL_ATTEMPTS: u32 = 20;
const OWN_SIDECAR_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// ログインシェルでの`$PATH`解決を待つ上限（壊れた.zshrc等で無限に待たないための保険）。
const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const SIDECAR_PROTOCOL: u8 = 1;
const INSTANCE_ID_FILE: &str = ".sidecar-instance-id";

/// フォールバック画面へ返す起動状態。機密情報や生パスは含めず、利用者が取れる判断だけを返す。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartupStatus {
    #[default]
    Starting,
    Ready,
    StaleSidecar,
    PortOccupied,
    InternalError,
}

/// 起動したsidecarの子プロセスハンドル。アプリ終了時にkillするため`app.manage()`で保持する。
/// `starting`は`spawn_and_attach`の並行実行ガード（起動時の自動attach試行とフォールバック
/// ページの「再試行」ボタンが同時に走った場合に、起動途中の健全な子を後発の呼び出しが
/// killしてしまう競合を防ぐ）。
#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    starting: AtomicBool,
    status: Mutex<StartupStatus>,
}

fn status_priority(status: StartupStatus) -> u8 {
    match status {
        StartupStatus::Starting => 0,
        StartupStatus::InternalError => 1,
        StartupStatus::PortOccupied => 2,
        StartupStatus::StaleSidecar => 3,
        StartupStatus::Ready => 4,
    }
}

pub(crate) fn note_startup_status(app: &AppHandle, next: StartupStatus) {
    let Some(state) = app.try_state::<SidecarState>() else { return };
    let mut current = state.status.lock().unwrap();
    if status_priority(next) >= status_priority(*current) {
        *current = next;
    }
}

pub(crate) fn reset_startup_status(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else { return };
    *state.status.lock().unwrap() = StartupStatus::Starting;
}

pub(crate) fn startup_status(app: &AppHandle) -> StartupStatus {
    app.try_state::<SidecarState>()
        .map(|state| *state.status.lock().unwrap())
        .unwrap_or(StartupStatus::InternalError)
}

fn valid_instance_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn read_instance_id(path: &Path) -> std::io::Result<String> {
    let value = std::fs::read_to_string(path)?.trim().to_string();
    if valid_instance_id(&value) {
        Ok(value)
    } else {
        Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid sidecar instance id"))
    }
}

/// データ領域に永続する不透明IDを作る。temp file→hard linkで初回並行起動でも既存値を
/// 上書きせず、書きかけのIDを正規ファイルとして残さない。
pub(crate) fn load_or_create_instance_id(data_dir: &Path) -> std::io::Result<String> {
    std::fs::create_dir_all(data_dir)?;
    let target = data_dir.join(INSTANCE_ID_FILE);
    match read_instance_id(&target) {
        Ok(value) => return Ok(value),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        Err(_) => {}
    }

    let candidate = uuid::Uuid::new_v4().simple().to_string();
    let temp = data_dir.join(format!("{INSTANCE_ID_FILE}.{candidate}.tmp"));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(candidate.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);

    let linked = std::fs::hard_link(&temp, &target);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(candidate),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_instance_id(&target),
        Err(e) => Err(e),
    }
}

/// canonicalizeした保存先だけをSHA-256へ通し、healthに生パスを出さずデータ領域を照合する。
pub(crate) fn data_root_id(data_dir: &Path) -> std::io::Result<String> {
    let normalized = std::fs::canonicalize(data_dir)?;
    let digest = Sha256::digest(normalized.as_os_str().as_encoded_bytes());
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn expected_identity_for_data_dir(data_dir: &Path) -> std::io::Result<attach::ExpectedSidecarIdentity> {
    let instance_id = load_or_create_instance_id(data_dir)?;
    Ok(attach::ExpectedSidecarIdentity {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: SIDECAR_PROTOCOL,
        build_id: env!("SOLO_EIKAIWA_SIDECAR_BUILD_ID").to_string(),
        data_root_id: data_root_id(data_dir)?,
        instance_id,
    })
}

pub(crate) fn expected_identity(app: &AppHandle) -> Result<attach::ExpectedSidecarIdentity, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    expected_identity_for_data_dir(&data_dir).map_err(|e| e.to_string())
}

fn port_is_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok()
}

/// `spawn_and_attach`の多重実行防止ガード。`starting`をCASで確保し、Dropで必ず解放する
/// （途中のreturnがどこであっても解放漏れが起きないようにするため）。
struct StartingGuard<'a>(&'a AtomicBool);

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// アプリ終了イベント（`RunEvent::Exit`）から呼ぶ。起動中のsidecarがあれば終了させる。
pub fn kill_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    let child = state.child.lock().unwrap().take();
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

/// `SOLO_EIKAIWA_NO_ATTACH`指定時、指定ポートへのspawnをスキップすべきか（純粋ロジック）。
///
/// NO_ATTACHは「既存プロセスにアタッチせず、常に自前のsidecarを使う」という契約である。
/// この契約が破れる具体的な経路: spawnしたプロセスがEADDRINUSEで即死しても、そのポートに
/// 既に身元確認済みの別プロセス（例: ライブデーモン）が生きていれば、spawn後のヘルスポーリング
/// の`is_identified(port)`はそれを拾って`true`を返してしまい、「自分の子が起動成功した」と
/// 誤認してnavigateしてしまう（実機で発見）。事前にidentity確認しておき、既に応答があるなら
/// spawnそのものを行わず次の候補ポートへ進むことでこれを防ぐ。
/// 通常モード（検証付き再利用経由）ではこのガードを使わない: 再利用側で既に
/// identity一致を確認した上でspawnにフォールバックしてきているので、spawn_and_attach内で
/// 重ねて同じチェックをする理由が無い（`should_try_next_port`側の早期終了で十分）。
pub(crate) fn should_skip_spawn_due_to_existing_identity(no_attach: bool, port_already_identified: bool) -> bool {
    no_attach && port_already_identified
}

/// ログインシェルの標準出力から`$PATH`を抜き出すためのマーカー。.zshenv/.zprofile等が
/// 起動時にMOTD・nvm/pyenvのバージョン警告等を標準出力へ書くことがあり、素の`echo -n "$PATH"`
/// だけだとその雑音がPATH文字列の前後に混入し、`/opt/homebrew/bin`等の正しいエントリが
/// 壊れたPATHになってしまう（`Bun.which("claude")`がサイレントにnullになりLLM未導入相当へ
/// 劣化する形で顕在化。2026-07-10 実機再現）。マーカーで挟むことで雑音を無視して確実に
/// PATH本体だけを取り出す。
const PATH_MARKER_START: &str = "<SOLO_EIKAIWA_PATH>";
const PATH_MARKER_END: &str = "</SOLO_EIKAIWA_PATH>";

/// ログインシェルの標準出力からマーカー間のPATH文字列を抜き出す（純粋関数）。
/// マーカーが無い・空の場合はNone（呼び出し元が継承PATHへフォールバックする）。
pub(crate) fn extract_marked_path(output: &str) -> Option<String> {
    let start = output.find(PATH_MARKER_START)? + PATH_MARKER_START.len();
    let rest = &output[start..];
    let end = rest.find(PATH_MARKER_END)?;
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// `zsh -lc`でログインシェルの`$PATH`を取得する（`scripts/daemon-server.sh`と同じ狙い:
/// GUIから起動したTauriアプリは`/usr/bin:/bin:/usr/sbin:/sbin`程度の最小PATHしか継承しない
/// ため、brew/npm/公式インストーラのどこに入れたか分からないclaude/codexを解決できるようにする）。
/// タイムアウト付きで、タイムアウト時は子プロセスを`kill()`してから諦める
/// （殺さずに`recv_timeout`だけ諦めると、壊れた.zshrc等でハングした`zsh`プロセスが
/// 親の終了後もlaunchd配下に孤児として残り続ける実害があるため）。
/// 失敗/タイムアウト時はNoneを返す（呼び出し元は継承PATHにフォールバックする）。
fn capture_login_shell_path() -> Option<String> {
    let script = format!("echo -n \"{PATH_MARKER_START}$PATH{PATH_MARKER_END}\"");
    let mut child = match std::process::Command::new("/bin/zsh")
        .args(["-lc", &script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("sidecar: failed to spawn login shell for PATH capture: {e}");
            return None;
        }
    };

    let deadline = std::time::Instant::now() + LOGIN_SHELL_PATH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    log::warn!("sidecar: login shell PATH capture timed out; killing and falling back to inherited PATH");
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                log::warn!("sidecar: login shell PATH capture wait failed: {e}");
                return None;
            }
        }
    }

    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("sidecar: login shell PATH capture failed to collect output: {e}");
            return None;
        }
    };
    if !output.status.success() {
        log::warn!("sidecar: login shell PATH capture exited non-zero (code {:?})", output.status.code());
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_marked_path(&stdout)
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

/// solo-serverをsidecarとして指定ポートで起動する。成功したら（子プロセスハンドル,
/// プロセスが既に終了したかを示すフラグ）を返す。フラグは非同期に更新される
/// （ログ読み取りタスクが`Terminated`イベントを見た時点でtrueにする）ため、呼び出し元
/// （`spawn_and_attach`のヘルスポーリングループ）は毎回の試行のたびにこのフラグを読み、
/// プロセスが早期終了していれば残り試行を待たずに諦める設計にしている
/// （最後まで待ってから読むと、ポート競合で即終了した場合でも次善ポートへの
/// フォールバックが最大待ち時間分だけ遅延してしまうため）。
fn spawn_solo_server(
    app: &AppHandle,
    port: u16,
    resources_dir: &Path,
    data_dir: &Path,
    path_env: &str,
    log_path: &Path,
    identity: &attach::ExpectedSidecarIdentity,
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
        .env("SOLO_EIKAIWA_SIDECAR_PROTOCOL", identity.protocol.to_string())
        .env("SOLO_EIKAIWA_SIDECAR_BUILD_ID", &identity.build_id)
        .env("SOLO_EIKAIWA_DATA_ROOT_ID", &identity.data_root_id)
        .env("SOLO_EIKAIWA_SIDECAR_INSTANCE_ID", &identity.instance_id)
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
        let mut log_file = RotatingLog::open(&log_path);
        if !log_file.is_available() {
            log::error!("sidecar: failed to open log file {log_path:?}; sidecar output will not be persisted");
        }
        while let Some(event) = rx.recv().await {
            if let Some(line) = format_command_event(&event) {
                log_file.write_line(&line);
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
///
/// 起動時の自動attach試行（`spawn_initial_attach`のバックグラウンドスレッド）と
/// フォールバックページの「再試行」ボタン（`retry_attach`）は独立した経路から呼ばれ得るため、
/// 同時に走ると先発の起動途中の健全な子プロセスを後発が`previous.kill()`で誤って
/// 殺してしまう競合がある。`SidecarState.starting`をCASで確保し、既に進行中なら
/// 即座にfalseを返して直列化する。
pub fn spawn_and_attach(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<SidecarState>() else {
        log::error!("sidecar: SidecarState is not managed (internal bug); cannot spawn");
        return false;
    };
    if state.starting.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        log::warn!("sidecar: a spawn is already in progress; skipping this concurrent request");
        return false;
    }
    let _starting_guard = StartingGuard(&state.starting);

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
    let identity = match expected_identity_for_data_dir(&data_dir) {
        Ok(identity) => identity,
        Err(e) => {
            log::error!("sidecar: failed to prepare identity: {e}");
            note_startup_status(app, StartupStatus::InternalError);
            return false;
        }
    };

    let whisper_bin_dir = resources_dir.join("whisper-bin");
    let login_path = capture_login_shell_path();
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let path_env = effective_path(&whisper_bin_dir.display().to_string(), login_path.as_deref(), &inherited_path);

    let no_attach = attach::no_attach_forced();

    for &port in CANDIDATE_PORTS.iter() {
        let existing = attach::probe_identity(port, &identity);
        match existing {
            attach::IdentityStatus::Stale => note_startup_status(app, StartupStatus::StaleSidecar),
            attach::IdentityStatus::Foreign => note_startup_status(app, StartupStatus::PortOccupied),
            _ => {}
        }
        if should_skip_spawn_due_to_existing_identity(no_attach, existing == attach::IdentityStatus::Match) {
            note_startup_status(app, StartupStatus::PortOccupied);
            log::warn!(
                "sidecar: NO_ATTACH set but port {port} already answers as solo-eikaiwa; \
                 skipping spawn there (would immediately conflict) and trying the next port",
            );
            continue;
        }

        log::info!("sidecar: spawning solo-server on port {port}");
        let Some((child, exited)) = spawn_solo_server(
            app, port, &resources_dir, &data_dir, &path_env, &log_path, &identity,
        ) else {
            // 起動自体に失敗（バイナリ欠落等）。ポートを変えても無意味なので諦める。
            note_startup_status(app, StartupStatus::InternalError);
            break;
        };

        let previous = state.child.lock().unwrap().replace(child);
        if let Some(previous) = previous {
            // 前のポートの子が万一残っていれば片付ける（通常は既に自己終了しているはず）。
            let _ = previous.kill();
        }

        let mut identified = false;
        for attempt in 1..=OWN_SIDECAR_POLL_ATTEMPTS {
            if attach::is_identified(port, &identity) {
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
            let navigated = attach::navigate_to(app, port);
            note_startup_status(app, if navigated { StartupStatus::Ready } else { StartupStatus::InternalError });
            return navigated;
        }

        if should_try_next_port(identified, exited.load(Ordering::SeqCst)) {
            note_startup_status(
                app,
                if port_is_open(port) { StartupStatus::PortOccupied } else { StartupStatus::InternalError },
            );
            log::warn!("sidecar: solo-server on port {port} exited quickly (likely port conflict); trying next port");
            continue;
        }

        log::error!(
            "sidecar: solo-server on port {port} did not become healthy in time; giving up (see {log_path:?})",
        );
        note_startup_status(app, StartupStatus::InternalError);
        break;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::{
        data_root_id, effective_path, expected_identity_for_data_dir, extract_marked_path,
        format_command_event, load_or_create_instance_id, should_skip_spawn_due_to_existing_identity,
        should_try_next_port, status_priority, StartupStatus, CANDIDATE_PORTS, INSTANCE_ID_FILE,
    };
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("solo-eikaiwa-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn instance_id_is_persistent_per_data_root() {
        let dir = unique_temp_dir("identity");
        fs::create_dir_all(&dir).unwrap();
        let first = load_or_create_instance_id(&dir).unwrap();
        let second = load_or_create_instance_id(&dir).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupted_instance_id_is_rejected_without_replacement() {
        let dir = unique_temp_dir("corrupted-identity");
        fs::create_dir_all(&dir).unwrap();
        let identity_file = dir.join(INSTANCE_ID_FILE);
        fs::write(&identity_file, "broken\n").unwrap();
        assert_eq!(
            load_or_create_instance_id(&dir).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData,
        );
        assert_eq!(fs::read_to_string(identity_file).unwrap(), "broken\n");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn startup_status_has_stable_ui_codes_and_failure_priority() {
        assert_eq!(serde_json::to_string(&StartupStatus::StaleSidecar).unwrap(), r#""stale-sidecar""#);
        assert_eq!(serde_json::to_string(&StartupStatus::PortOccupied).unwrap(), r#""port-occupied""#);
        assert!(status_priority(StartupStatus::StaleSidecar) > status_priority(StartupStatus::PortOccupied));
        assert!(status_priority(StartupStatus::PortOccupied) > status_priority(StartupStatus::InternalError));
    }

    #[test]
    fn data_root_id_is_stable_but_does_not_expose_the_path() {
        let first = unique_temp_dir("root-a");
        let second = unique_temp_dir("root-b");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let id1 = data_root_id(&first).unwrap();
        assert_eq!(id1, data_root_id(&first).unwrap());
        assert_ne!(id1, data_root_id(&second).unwrap());
        assert_eq!(id1.len(), 64);
        assert!(!id1.contains(first.to_string_lossy().as_ref()));
        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn build_id_is_the_bundled_sidecar_sha256() {
        let dir = unique_temp_dir("build-id");
        fs::create_dir_all(&dir).unwrap();
        let build_id = expected_identity_for_data_dir(&dir).unwrap().build_id;
        assert_eq!(build_id.len(), 64);
        assert!(build_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn should_skip_spawn_only_when_no_attach_and_port_already_identified() {
        // NO_ATTACH指定時、既に別プロセスが身元確認できる状態ならspawnせずスキップする。
        assert!(should_skip_spawn_due_to_existing_identity(true, true));
        // NO_ATTACH指定時でも、そのポートに何も無ければ通常どおりspawnする。
        assert!(!should_skip_spawn_due_to_existing_identity(true, false));
        // 通常モード（検証付き再利用経由）ではこのガードを使わない設計なので、
        // 既に応答があってもfalse（=spawnする）を返す。
        assert!(!should_skip_spawn_due_to_existing_identity(false, true));
        assert!(!should_skip_spawn_due_to_existing_identity(false, false));
    }

    #[test]
    fn extract_marked_path_returns_value_between_markers() {
        assert_eq!(
            extract_marked_path("<SOLO_EIKAIWA_PATH>/usr/bin:/opt/homebrew/bin</SOLO_EIKAIWA_PATH>").unwrap(),
            "/usr/bin:/opt/homebrew/bin",
        );
    }

    #[test]
    fn extract_marked_path_ignores_noise_before_and_after_markers() {
        // .zshenv/.zprofile 等がMOTD・バージョン警告を標準出力に書く場合を想定した回帰テスト。
        let noisy = "nvm: version outdated\nWarning: something\n\
            <SOLO_EIKAIWA_PATH>/usr/bin:/opt/homebrew/bin</SOLO_EIKAIWA_PATH>\ntrailing noise";
        assert_eq!(extract_marked_path(noisy).unwrap(), "/usr/bin:/opt/homebrew/bin");
    }

    #[test]
    fn extract_marked_path_none_when_markers_missing() {
        assert_eq!(extract_marked_path("/usr/bin:/opt/homebrew/bin"), None);
    }

    #[test]
    fn extract_marked_path_none_when_empty_between_markers() {
        assert_eq!(extract_marked_path("<SOLO_EIKAIWA_PATH></SOLO_EIKAIWA_PATH>"), None);
    }

    #[test]
    fn starting_flag_compare_exchange_prevents_concurrent_claim() {
        // spawn_and_attach の並行実行ガードが使うCAS操作そのものの意味論を固定するテスト
        // （AtomicBool/CompareExchangeの標準挙動だが、ガード実装の前提を明示的に確認する）。
        let flag = AtomicBool::new(false);
        assert!(flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok());
        assert!(flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err());
        flag.store(false, Ordering::SeqCst);
        assert!(flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok());
    }

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
    fn candidate_ports_leave_room_for_browser_and_development_servers() {
        assert_eq!(CANDIDATE_PORTS, [3111, 3112, 3113, 3114]);
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
