// withGlobalTauri は無効化している（アプリ本体のオリジンにTauriのJS APIオブジェクトを
// 一切公開しないため）。そのため window.__TAURI__ の便利ラッパーは使わず、常に注入される
// 低レベルの window.__TAURI_INTERNALS__.invoke を直接呼ぶ。
const button = document.getElementById("retry");
const status = document.getElementById("status");
const title = document.getElementById("title");
const message = document.getElementById("message");
const messageEn = document.getElementById("message-en");

const FAILED_TITLE = "起動に失敗しました";
const FAILED_MESSAGE = "ローカルサーバを起動できませんでした。しばらく待ってから再試行するか、上記のログファイルを確認してください。";
const FAILED_MESSAGE_EN = "Failed to start the local server. Retry in a moment, or check the log file above for details.";

function showFailed() {
  title.textContent = FAILED_TITLE;
  message.textContent = FAILED_MESSAGE;
  messageEn.textContent = FAILED_MESSAGE_EN;
}

// 起動が正常に進んでいれば、Rust側がこのウィンドウをnavigate()で実アプリへ切り替えるため
// このページ・スクリプトごと消える。一定時間経ってもまだこのページにいる（＝navigateされて
// いない）ということは起動に失敗しているとみなし、初期表示の「起動中です」から
// 「起動に失敗しました」へ切り替える（配布ユーザーが正常な起動待ち時間中に毎回
// 失敗文言を見てしまう問題への対応）。
//
// 25秒の根拠 = サーバ側（src-tauri/src/sidecar.rs）の最悪ケース待ち時間: 正常だが遅い初回起動
// （配布ユーザーの初回 = DB新規作成で最も遅い）でport 3111が空振り→3112へフォールバックする
// 場合、OWN_SIDECAR_POLL_ATTEMPTS(20)×OWN_SIDECAR_POLL_INTERVAL(500ms)=10秒/ポート×2ポート
// +ログインシェルPATH取得(LOGIN_SHELL_PATH_TIMEOUT=3秒)+attach-first側の待ち(数百ms)で
// 最大23秒程度かかり得る。sidecar.rs側のこれらの定数を変えた場合はこの値も追従させること。
const STARTUP_TIMEOUT_MS = 25000;
const startupTimer = setTimeout(showFailed, STARTUP_TIMEOUT_MS);

button.addEventListener("click", async () => {
  clearTimeout(startupTimer);
  button.disabled = true;
  status.textContent = "確認中... / Checking...";
  try {
    const attached = await window.__TAURI_INTERNALS__.invoke("retry_attach");
    if (!attached) {
      showFailed();
      status.textContent = "まだ起動していません。/ Still not running.";
    }
    // 成功時は Rust 側がこのウィンドウを実アプリのURLへ遷移させるため、ここでは何もしない。
  } catch (err) {
    showFailed();
    status.textContent = "確認に失敗しました。/ Check failed.";
    console.error(err);
  } finally {
    button.disabled = false;
  }
});
