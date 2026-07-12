mod attach;
mod diagnostic_log;
mod sidecar;
mod updater;
pub mod updater_signature;

use tauri::menu::{Menu, MenuItem};
use tauri::{Manager, RunEvent};

/// メニュー「アップデートを確認…」のイベントID（アプリ内で一意にする）。
const MENU_ID_CHECK_UPDATES: &str = "check-for-updates";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      // release でも登録する: updater・sidecar の失敗診断にログが必須のため。
      // 出力先は stdout（ターミナル起動・E2E用）と OS 標準のログディレクトリ
      // （~/Library/Logs/<bundle-id>/。Finder起動時の事後診断用）。
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
          ])
          .build(),
      )?;
      app.manage(sidecar::SidecarState::default());
      attach::spawn_initial_attach(app.handle().clone());

      // macOS: 最初のSubmenuがラベルに関係なくアプリ名メニューになる（公式仕様）。
      // Menu::default()の先頭Submenu（About(0)/Separator(1)/Services(2)/...）のAbout直後
      // = index 1 に「アップデートを確認…」を挿入する（Sparkle系アプリと同じ慣例配置）。
      let menu = Menu::default(app.handle())?;
      if let Some(app_submenu) = menu.items()?.first().and_then(|k| k.as_submenu().cloned()) {
        let item = MenuItem::with_id(
          app,
          MENU_ID_CHECK_UPDATES,
          updater::check_menu_label(updater::current_lang()),
          true,
          None::<&str>,
        )?;
        app.manage(updater::UpdateMenuState::new(item.clone()));
        app_submenu.insert(&item, 1)?;
      }
      app.set_menu(menu)?;
      // 更新フローが状態を変更する前に、表示対象のメニューを登録しておく。
      updater::spawn_startup_check(app.handle().clone());
      Ok(())
    })
    .on_menu_event(|app, event| {
      if event.id() == MENU_ID_CHECK_UPDATES {
        updater::spawn_manual_check(app.clone());
      }
    })
    .invoke_handler(tauri::generate_handler![attach::retry_attach, attach::startup_status])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // アプリ終了時: 自前spawnしたsidecarが残っていればkillする（アタッチのみの場合は何もしない）。
      if let RunEvent::Exit = event {
        sidecar::kill_on_exit(app_handle);
      }
    });
}
