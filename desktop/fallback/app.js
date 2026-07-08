// withGlobalTauri は無効化している（アプリ本体のオリジンにTauriのJS APIオブジェクトを
// 一切公開しないため）。そのため window.__TAURI__ の便利ラッパーは使わず、常に注入される
// 低レベルの window.__TAURI_INTERNALS__.invoke を直接呼ぶ。
const button = document.getElementById("retry");
const status = document.getElementById("status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "確認中... / Checking...";
  try {
    const attached = await window.__TAURI_INTERNALS__.invoke("retry_attach");
    if (!attached) {
      status.textContent = "まだ起動していません。/ Still not running.";
    }
    // 成功時は Rust 側がこのウィンドウを実アプリのURLへ遷移させるため、ここでは何もしない。
  } catch (err) {
    status.textContent = "確認に失敗しました。/ Check failed.";
    console.error(err);
  } finally {
    button.disabled = false;
  }
});
