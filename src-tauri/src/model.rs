use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub capture_enabled: bool,
    pub max_items: usize,
    pub retention_days: u64,
    pub max_text_length: usize,
    #[serde(default = "text_limit_version")]
    pub text_limit_migration_version: u32,
    pub max_image_bytes: usize,
    pub hotkey: String,
    pub launch_at_startup: bool,
    pub startup_decision_version: u32,
    pub sensitive_filter_enabled: bool,
}

fn text_limit_version() -> u32 { 1 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            capture_enabled: true,
            max_items: 500,
            retention_days: 30,
            max_text_length: 1_000_000,
            text_limit_migration_version: 1,
            max_image_bytes: 10 * 1024 * 1024,
            hotkey: "Ctrl+Alt+V".into(),
            launch_at_startup: true,
            startup_decision_version: 1,
            sensitive_filter_enabled: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableSettingsPatch {
    pub capture_enabled: Option<bool>,
    pub max_items: Option<usize>,
    pub retention_days: Option<u64>,
    pub max_text_length: Option<usize>,
    pub max_image_bytes: Option<usize>,
    pub hotkey: Option<String>,
    pub sensitive_filter_enabled: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct HistoryQuery {
    pub search: Option<String>,
    #[serde(rename = "type")]
    pub history_type: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StoredItem {
    #[serde(rename_all = "camelCase")]
    Text {
        id: String, hash: String, content_key: String, created_at: String,
        updated_at: String, pinned: bool, copy_count: u64,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        id: String, hash: String, content_key: String, thumbnail_key: String,
        width: u32, height: u32, byte_size: u64, created_at: String,
        updated_at: String, pinned: bool, copy_count: u64,
    },
    #[serde(rename_all = "camelCase")]
    File {
        id: String, hash: String, content_key: String, byte_size: u64,
        created_at: String, updated_at: String, pinned: bool, copy_count: u64,
    },
}

impl StoredItem {
    pub fn id(&self) -> &str { match self { Self::Text{id, ..}|Self::Image{id, ..}|Self::File{id, ..} => id } }
    pub fn hash(&self) -> &str { match self { Self::Text{hash, ..}|Self::Image{hash, ..}|Self::File{hash, ..} => hash } }
    pub fn kind(&self) -> &str { match self { Self::Text{..}=>"text", Self::Image{..}=>"image", Self::File{..}=>"file" } }
    pub fn content_key(&self) -> &str { match self { Self::Text{content_key, ..}|Self::Image{content_key, ..}|Self::File{content_key, ..} => content_key } }
    pub fn updated_at(&self) -> &str { match self { Self::Text{updated_at, ..}|Self::Image{updated_at, ..}|Self::File{updated_at, ..} => updated_at } }
    pub fn pinned(&self) -> bool { match self { Self::Text{pinned, ..}|Self::Image{pinned, ..}|Self::File{pinned, ..} => *pinned } }
    pub fn set_pinned(&mut self, value: bool, now: String) { match self { Self::Text{pinned,updated_at,..}|Self::Image{pinned,updated_at,..}|Self::File{pinned,updated_at,..} => { *pinned=value; *updated_at=now; } } }
    pub fn touch(&mut self, now: String) { match self { Self::Text{updated_at,copy_count,..}|Self::Image{updated_at,copy_count,..}|Self::File{updated_at,copy_count,..} => { *updated_at=now; *copy_count += 1; } } }
    pub fn content_keys(&self) -> Vec<&str> { match self { Self::Image{content_key,thumbnail_key,..}=>vec![content_key,thumbnail_key], _=>vec![self.content_key()] } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum HistoryItem {
    #[serde(rename_all = "camelCase")]
    Text { id: String, text: String, created_at: String, updated_at: String, pinned: bool, copy_count: u64 },
    #[serde(rename_all = "camelCase")]
    Image { id: String, thumbnail_data_url: String, width: u32, height: u32, byte_size: u64, created_at: String, updated_at: String, pinned: bool, copy_count: u64 },
    #[serde(rename_all = "camelCase")]
    File { id: String, path: String, name: String, extension: String, byte_size: u64, missing: bool, created_at: String, updated_at: String, pinned: bool, copy_count: u64 },
}

impl HistoryItem {
    pub fn updated_at(&self) -> &str { match self { Self::Text{updated_at,..}|Self::Image{updated_at,..}|Self::File{updated_at,..}=>updated_at } }
    pub fn searchable_text(&self) -> Option<String> { match self { Self::Text{text,..}=>Some(text.clone()), Self::File{path,name,..}=>Some(format!("{name}\n{path}")), _=>None } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats { pub total_items: usize, pub text_items: usize, pub image_items: usize, pub file_items: usize, pub image_bytes: u64 }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupState { pub desired_enabled: bool, pub actual_enabled: Option<bool>, pub pending_decision: bool, pub managed: bool, pub error: Option<String> }

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    pub mode: String, pub helper_pid: Option<u32>, pub helper_generation: u64,
    pub last_event_at: Option<u64>, pub last_sequence: Option<u64>, pub restart_count: u64,
    pub next_restart_at: Option<u64>, pub gap_count: u64, pub filtered_count: u64,
    pub queue_depth: u64, pub queue_bytes: u64, pub last_exit: Option<serde_json::Value>,
    pub last_error: Option<String>,
}

impl Default for BackgroundState {
    fn default() -> Self { Self { mode:"starting".into(), helper_pid:None, helper_generation:0, last_event_at:None, last_sequence:None, restart_count:0, next_restart_at:None, gap_count:0, filtered_count:0, queue_depth:0, queue_bytes:0, last_exit:None, last_error:None } }
}
