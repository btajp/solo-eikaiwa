mod attach;
mod sidecar;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      app.manage(sidecar::SidecarState::default());
      attach::spawn_initial_attach(app.handle().clone());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![attach::retry_attach])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // アプリ終了時: 自前spawnしたsidecarが残っていればkillする（アタッチのみの場合は何もしない）。
      if let RunEvent::Exit = event {
        sidecar::kill_on_exit(app_handle);
      }
    });
}
