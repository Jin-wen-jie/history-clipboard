mod clipboard_agent;
mod crypto;
mod model;
mod store;

use arboard::{Clipboard, ImageData};
use model::*;
use serde::{Deserialize,Serialize};
use std::{borrow::Cow, fs, path::PathBuf, process::Command, sync::{Arc, Mutex}};
use store::{ClipboardContent, HistoryStore};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct AppState {
    store: Arc<Mutex<HistoryStore>>,
    background: Arc<Mutex<BackgroundState>>,
    window_state_path:PathBuf,
}

#[derive(Debug,PartialEq,Serialize,Deserialize)]
struct WindowBounds{x:Option<i32>,y:Option<i32>,width:u32,height:u32}

fn locked_store<'a>(state:&'a State<'_,AppState>)->Result<std::sync::MutexGuard<'a,HistoryStore>,String>{state.store.lock().map_err(|_|"history store lock failed".into())}

#[tauri::command]
fn history_list(state:State<AppState>,query:Option<HistoryQuery>)->Result<Vec<HistoryItem>,String>{Ok(locked_store(&state)?.list(&query.unwrap_or_default()))}
#[tauri::command]
fn history_delete(state:State<AppState>,id:String)->Result<serde_json::Value,String>{Ok(serde_json::json!({"ok":locked_store(&state)?.delete(&id)?}))}
#[tauri::command]
fn history_delete_many(state:State<AppState>,ids:Vec<String>)->Result<serde_json::Value,String>{let count=locked_store(&state)?.delete_many(&ids)?;Ok(serde_json::json!({"ok":true,"count":count}))}
#[tauri::command]
fn history_clear(state:State<AppState>,history_type:Option<String>)->Result<(),String>{locked_store(&state)?.clear(history_type.as_deref())}
#[tauri::command]
fn history_set_pinned(state:State<AppState>,id:String,pinned:bool)->Result<serde_json::Value,String>{Ok(serde_json::json!({"ok":locked_store(&state)?.set_pinned(&id,pinned)?}))}

#[tauri::command]
fn history_copy(state:State<AppState>,id:String)->Result<serde_json::Value,String>{
    let content=locked_store(&state)?.get_content(&id)?;
    let Some(content)=content else{return Ok(serde_json::json!({"ok":false}))};
    match content {
        ClipboardContent::Text(text)=>Clipboard::new().and_then(|mut c|c.set_text(text)).map_err(|e|e.to_string())?,
        ClipboardContent::Image(png)=>{let decoded=image::load_from_memory(&png).map_err(|e|e.to_string())?.to_rgba8();let(width,height)=decoded.dimensions();Clipboard::new().and_then(|mut c|c.set_image(ImageData{width:width as usize,height:height as usize,bytes:Cow::Owned(decoded.into_raw())})).map_err(|e|e.to_string())?;},
        ClipboardContent::File(path)=>{if !PathBuf::from(&path).is_file(){return Ok(serde_json::json!({"ok":false,"reason":"missing"}))}let status=Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-Command","Set-Clipboard -LiteralPath $args[0]",&path]).creation_flags(0x0800_0000).status().map_err(|e|e.to_string())?;if !status.success(){return Ok(serde_json::json!({"ok":false}))}},
    }
    Ok(serde_json::json!({"ok":true}))
}

#[tauri::command]
fn history_copy_image_path(state:State<AppState>,id:String)->Result<serde_json::Value,String>{
    let content=locked_store(&state)?.get_content(&id)?;
    let Some(content)=content else{return Ok(serde_json::json!({"ok":false,"reason":"missing"}))};
    let ClipboardContent::Image(png)=content else{return Ok(serde_json::json!({"ok":false,"reason":"not-image"}))};
    let export_dir=data_root()?.join("exported-images");
    fs::create_dir_all(&export_dir).map_err(|e|e.to_string())?;
    let image_path=export_dir.join(format!("{id}.png"));
    fs::write(&image_path,png).map_err(|e|e.to_string())?;
    let path=image_path.to_string_lossy().into_owned();
    Clipboard::new().and_then(|mut clipboard|clipboard.set_text(path.clone())).map_err(|e|e.to_string())?;
    Ok(serde_json::json!({"ok":true,"path":path}))
}

#[tauri::command]
fn history_preview(state:State<AppState>,id:String)->Result<serde_json::Value,String>{
    let Some(content)=locked_store(&state)?.get_content(&id)? else{return Ok(serde_json::json!({"ok":false,"reason":"missing"}))};
    match content {
        ClipboardContent::Image(png)=>Ok(serde_json::json!({"ok":true,"type":"image","png":png})),
        ClipboardContent::File(path)=>{let file=PathBuf::from(&path);if !file.is_file(){return Ok(serde_json::json!({"ok":false,"reason":"missing"}))}let supported=["txt","json","md","log","csv","xml","yaml","yml","ini","conf","js","jsx","ts","tsx","css","html"];let extension=file.extension().and_then(|v|v.to_str()).unwrap_or("").to_lowercase();if !supported.contains(&extension.as_str()){return Ok(serde_json::json!({"ok":false,"reason":"unsupported"}))}let metadata=fs::metadata(&file).map_err(|e|e.to_string())?;if metadata.len()>2*1024*1024{return Ok(serde_json::json!({"ok":false,"reason":"too-large"}))}let raw=fs::read_to_string(file).map_err(|e|e.to_string())?;let(formatted,text)=if extension=="json"{match serde_json::from_str::<serde_json::Value>(&raw){Ok(v)=>(true,serde_json::to_string_pretty(&v).unwrap_or(raw)),Err(_)=>(false,raw)}}else{(false,raw)};Ok(serde_json::json!({"ok":true,"type":"file-text","text":text,"formatted":formatted}))},
        ClipboardContent::Text(_)=>Ok(serde_json::json!({"ok":false,"reason":"unsupported"})),
    }
}

#[tauri::command]
fn settings_get(state:State<AppState>)->Result<AppSettings,String>{Ok(locked_store(&state)?.settings.clone())}
#[tauri::command]
fn settings_update(app:tauri::AppHandle,state:State<AppState>,settings:EditableSettingsPatch)->Result<AppSettings,String>{
    let before=locked_store(&state)?.settings.clone();
    let updated=locked_store(&state)?.update_settings(settings)?;
    if updated.hotkey!=before.hotkey{let _=app.global_shortcut().unregister_all();let _=register_hotkey(&app,&updated.hotkey);}
    if !before.capture_enabled&&updated.capture_enabled{let _=clipboard_agent::reconcile_now(&state.store);}
    Ok(updated)
}
#[tauri::command]
fn stats_get(state:State<AppState>)->Result<StorageStats,String>{Ok(locked_store(&state)?.stats())}
#[tauri::command]
fn background_get_state(state:State<AppState>)->Result<BackgroundState,String>{state.background.lock().map(|v|v.clone()).map_err(|_|"background state lock failed".into())}

#[tauri::command]
fn startup_get_state(app:tauri::AppHandle,state:State<AppState>)->Result<StartupState,String>{let desired=locked_store(&state)?.settings.launch_at_startup;match app.autolaunch().is_enabled(){Ok(actual)=>Ok(StartupState{desired_enabled:desired,actual_enabled:Some(actual),pending_decision:false,managed:true,error:if actual==desired{None}else{Some("state-mismatch".into())}}),Err(_)=>Ok(StartupState{desired_enabled:desired,actual_enabled:None,pending_decision:false,managed:true,error:Some("query-failed".into())})}}
#[tauri::command]
fn startup_set_enabled(app:tauri::AppHandle,state:State<AppState>,enabled:bool)->Result<StartupState,String>{let operation=if enabled{app.autolaunch().enable()}else{app.autolaunch().disable()};if operation.is_err(){return Ok(StartupState{desired_enabled:enabled,actual_enabled:None,pending_decision:false,managed:true,error:Some("apply-failed".into())})}locked_store(&state)?.set_startup(enabled)?;startup_get_state(app,state)}
#[tauri::command]
fn window_show(app:tauri::AppHandle)->Result<(),String>{show_window(&app)}

#[tauri::command]
fn history_export(state:State<AppState>)->Result<serde_json::Value,String>{let json=locked_store(&state)?.export_json()?;let Some(path)=rfd::FileDialog::new().set_title("导出剪贴板历史").add_filter("剪贴板备份",&["hcbk"]).set_file_name(format!("剪贴板备份-{}.hcbk",chrono::Local::now().format("%Y-%m-%d"))).save_file()else{return Ok(serde_json::json!({"ok":false,"reason":"cancelled"}))};fs::write(path,json).map_err(|e|e.to_string())?;Ok(serde_json::json!({"ok":true}))}
#[tauri::command]
fn history_import(state:State<AppState>)->Result<serde_json::Value,String>{let Some(path)=rfd::FileDialog::new().set_title("导入剪贴板历史").add_filter("剪贴板备份",&["hcbk"]).pick_file()else{return Ok(serde_json::json!({"ok":false,"reason":"cancelled"}))};let input=fs::read_to_string(path).map_err(|e|e.to_string())?;let(imported,skipped)=locked_store(&state)?.import_json(&input)?;Ok(serde_json::json!({"ok":true,"imported":imported,"skipped":skipped}))}

fn show_window(app:&tauri::AppHandle)->Result<(),String>{let window=app.get_webview_window("main").ok_or("main window is missing")?;if window.is_minimized().unwrap_or(false){window.unminimize().map_err(|e|e.to_string())?}window.show().map_err(|e|e.to_string())?;window.set_focus().map_err(|e|e.to_string())?;Ok(())}
fn register_hotkey(app:&tauri::AppHandle,hotkey:&str)->Result<(),String>{app.global_shortcut().register(hotkey).map_err(|e|e.to_string())}

fn restore_window_bounds(window:&tauri::WebviewWindow,path:&PathBuf){
    let Some(bounds)=read_window_bounds(path)else{return};
    if bounds.width>=760&&bounds.height>=520&&bounds.width<=10_000&&bounds.height<=10_000{let _=window.set_size(tauri::PhysicalSize::new(bounds.width,bounds.height));}
    if let(Some(x),Some(y))=(bounds.x,bounds.y){let _=window.set_position(tauri::PhysicalPosition::new(x,y));}
}

fn save_window_bounds(window:&tauri::Window)->Result<(),String>{
    let state=window.state::<AppState>();
    let position=window.outer_position().map_err(|error|error.to_string())?;
    let size=window.inner_size().map_err(|error|error.to_string())?;
    let bounds=WindowBounds{x:Some(position.x),y:Some(position.y),width:size.width,height:size.height};
    write_window_bounds(&state.window_state_path,&bounds)
}

fn read_window_bounds(path:&PathBuf)->Option<WindowBounds>{serde_json::from_slice(&fs::read(path).ok()?).ok()}
fn write_window_bounds(path:&PathBuf,bounds:&WindowBounds)->Result<(),String>{fs::write(path,serde_json::to_vec(bounds).map_err(|error|error.to_string())?).map_err(|error|error.to_string())}

fn data_root()->Result<PathBuf,String>{
    if let Some(path)=std::env::var_os("HISTORY_CLIPBOARD_DATA_DIR"){return Ok(PathBuf::from(path))}
    dirs::data_dir().map(|path|path.join("history-clipboard")).ok_or("Windows roaming data directory is unavailable".into())
}

pub fn data_self_test(output:String)->Result<(),String>{
    let result=(||->Result<serde_json::Value,String>{
        let store=HistoryStore::load(data_root()?)?;
        let visible=store.list(&HistoryQuery::default());
        Ok(serde_json::json!({"ok":true,"visibleItems":visible.len(),"stats":store.stats()}))
    })();
    let payload=match result{Ok(value)=>value,Err(error)=>serde_json::json!({"ok":false,"error":error})};
    fs::write(output,serde_json::to_vec(&payload).map_err(|error|error.to_string())?).map_err(|error|error.to_string())?;
    if payload.get("ok").and_then(serde_json::Value::as_bool)==Some(true){Ok(())}else{Err(payload.get("error").and_then(serde_json::Value::as_str).unwrap_or("data self-test failed").into())}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app,_args,_cwd|{let _=show_window(app);} ))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent,Some(vec!["--launch-at-login"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app,_,event|{if event.state()==ShortcutState::Pressed{if let Some(window)=app.get_webview_window("main"){if window.is_visible().unwrap_or(false){let _=window.hide();}else{let _=show_window(app);}}}}).build())
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .setup(|app| {
            let root=data_root()?;
            let window_state_path=root.join("window-state.json");
            let store=Arc::new(Mutex::new(HistoryStore::load(root)?));
            let background=Arc::new(Mutex::new(BackgroundState::default()));
            let settings=store.lock().unwrap().settings.clone();
            let _=register_hotkey(app.handle(),&settings.hotkey);
            let _=if settings.launch_at_startup{app.autolaunch().enable()}else{app.autolaunch().disable()};
            app.manage(AppState{store:store.clone(),background:background.clone(),window_state_path:window_state_path.clone()});
            if let Some(window)=app.get_webview_window("main"){window.remove_menu()?;restore_window_bounds(&window,&window_state_path);}
            let open=MenuItem::with_id(app,"open","打开历史剪贴板",true,None::<&str>)?;
            let pause=MenuItem::with_id(app,"pause","暂停/恢复记录",true,None::<&str>)?;
            let quit=MenuItem::with_id(app,"quit","退出",true,None::<&str>)?;
            let menu=Menu::with_items(app,&[&open,&pause,&quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("application icon is missing")?.clone())
                .tooltip("历史剪贴板")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app,event|match event.id().as_ref(){
                    "open"=>{let _=show_window(app);},
                    "pause"=>{let state=app.state::<AppState>();let enabled=if let Ok(mut store)=state.store.lock(){let enabled=!store.settings.capture_enabled;let _=store.update_settings(EditableSettingsPatch{capture_enabled:Some(enabled),..Default::default()});enabled}else{false};if enabled{let _=clipboard_agent::reconcile_now(&state.store);}},
                    "quit"=>app.exit(0),
                    _=>{}
                })
                .on_tray_icon_event(|tray,event|{
                    if matches!(event,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){
                        let app=tray.app_handle();
                        if let Some(window)=app.get_webview_window("main"){
                            if window.is_visible().unwrap_or(false){let _=window.hide();}else{let _=show_window(app);}
                        }
                    }
                })
                .build(app)?;
            let helper=app.path().resource_dir()?.join("clipboard-listener.exe");
            log::info!("clipboard helper path: {}",helper.display());
            clipboard_agent::start(helper,store.clone(),background.clone());
            if !std::env::args().any(|arg|arg=="--launch-at-login"){show_window(app.handle())?;}
            Ok(())
        })
        .on_window_event(|window,event|match event{
            tauri::WindowEvent::CloseRequested{api,..}=>{api.prevent_close();let _=window.hide();},
            tauri::WindowEvent::Moved(_)|tauri::WindowEvent::Resized(_)=>{if let Err(error)=save_window_bounds(window){log::error!("window state save failed: {error}");}},
            _=>{}
        })
        .invoke_handler(tauri::generate_handler![history_list,history_copy,history_copy_image_path,history_preview,history_delete,history_delete_many,history_clear,history_set_pinned,settings_get,settings_update,stats_get,startup_get_state,startup_set_enabled,background_get_state,window_show,history_export,history_import])
        .run(tauri::generate_context!())
        .expect("error while running history clipboard");
}

#[cfg(windows)]
trait WindowsCommandExt { fn creation_flags(&mut self, flags:u32)->&mut Self; }
#[cfg(windows)]
impl WindowsCommandExt for Command { fn creation_flags(&mut self,flags:u32)->&mut Self { use std::os::windows::process::CommandExt; CommandExt::creation_flags(self,flags);self } }

#[cfg(test)]
mod tests{
    use super::{read_window_bounds,write_window_bounds,WindowBounds};

    #[test]
    fn window_bounds_round_trip_in_the_legacy_format(){
        let path=std::env::temp_dir().join(format!("history-clipboard-window-{}.json",uuid::Uuid::new_v4()));
        let expected=WindowBounds{x:Some(120),y:Some(80),width:980,height:700};
        write_window_bounds(&path,&expected).unwrap();assert_eq!(read_window_bounds(&path),Some(expected));let _=std::fs::remove_file(path);
    }
}
