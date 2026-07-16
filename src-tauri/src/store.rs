use crate::{crypto::{decrypt_content, encrypt_content, load_or_create_content_key}, model::*};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use image::ImageReader;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Cursor, path::{Path, PathBuf}};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Metadata { version: u32, #[serde(default)] revision: u64, items: Vec<StoredItem> }

#[derive(Default, Deserialize)]
#[serde(rename_all="camelCase")]
struct StoredSettingsPatch{
    capture_enabled:Option<bool>,max_items:Option<usize>,retention_days:Option<u64>,
    max_text_length:Option<usize>,text_limit_migration_version:Option<u32>,
    max_image_bytes:Option<usize>,hotkey:Option<String>,launch_at_startup:Option<bool>,
    startup_decision_version:Option<u32>,sensitive_filter_enabled:Option<bool>,
}

struct InstallationEvidence{settings_exists:bool,settings_corrupt:bool,history_exists:bool,vault_key_exists:bool,content_exists:bool}

pub enum ClipboardContent { Text(String), Image(Vec<u8>), File(String) }

pub struct HistoryStore {
    root: PathBuf,
    key: [u8; 32],
    revision: u64,
    pub settings: AppSettings,
    pub items: Vec<StoredItem>,
}

impl HistoryStore {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        let settings_path=root.join("settings.json");
        let settings_exists=settings_path.exists();
        let raw_settings=fs::read(&settings_path).ok().and_then(|bytes|serde_json::from_slice::<StoredSettingsPatch>(&bytes).ok());
        let settings_corrupt=settings_exists&&raw_settings.is_none();
        let history_exists=["history.json","history.json.tmp","history.json.bak"].iter().any(|name|root.join(name).exists());
        let vault_key_exists=root.join("vault.key").exists();
        let content_path=root.join("content");
        let content_exists=fs::read_dir(&content_path).ok().is_some_and(|mut entries|entries.next().is_some());
        fs::create_dir_all(root.join("content")).map_err(|e| e.to_string())?;
        let key = load_or_create_content_key(&root)?;
        let settings=migrate_settings(raw_settings,InstallationEvidence{settings_exists,settings_corrupt,history_exists,vault_key_exists,content_exists});
        let metadata = ["history.json", "history.json.tmp", "history.json.bak"]
            .iter().filter_map(|name| read_json::<Metadata>(&root.join(name)))
            .max_by_key(|candidate| candidate.revision)
            .unwrap_or(Metadata { version: 1, revision: 0, items: vec![] });
        Ok(Self { root, key, revision: metadata.revision, settings, items: metadata.items })
    }

    pub fn list(&self, query: &HistoryQuery) -> Vec<HistoryItem> {
        let search = query.search.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_lowercase);
        let from = query.from.as_deref().and_then(parse_time);
        let to = query.to.as_deref().and_then(parse_time);
        let mut result: Vec<_> = self.items.iter().filter_map(|stored| {
            if query.history_type.as_deref().is_some_and(|value| value != "all" && value != stored.kind()) { return None; }
            let item = self.to_public(stored).ok()?;
            let updated = parse_time(item.updated_at())?;
            if from.is_some_and(|value| updated < value) || to.is_some_and(|value| updated > value) { return None; }
            if let Some(needle) = &search {
                let haystack=item.searchable_text()?;
                if !haystack.to_lowercase().contains(needle) { return None; }
            }
            Some(item)
        }).collect();
        result.sort_by(|a, b| b.updated_at().cmp(a.updated_at()));
        result.sort_by_key(|item| match item { HistoryItem::Text{pinned,..}|HistoryItem::Image{pinned,..}|HistoryItem::File{pinned,..} => !*pinned });
        result
    }

    pub fn get_content(&self, id: &str) -> Result<Option<ClipboardContent>, String> {
        let Some(item) = self.items.iter().find(|item| item.id() == id) else { return Ok(None); };
        let bytes = self.read_vault(item.content_key())?;
        match item {
            StoredItem::Text { .. } => Ok(Some(ClipboardContent::Text(String::from_utf8(bytes).map_err(|e| e.to_string())?))),
            StoredItem::Image { .. } => Ok(Some(ClipboardContent::Image(bytes))),
            StoredItem::File { .. } => {
                let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                Ok(value.get("path").and_then(|v| v.as_str()).map(|path| ClipboardContent::File(path.into())))
            }
        }
    }

    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<bool, String> {
        let Some(item) = self.items.iter_mut().find(|item| item.id() == id) else { return Ok(false); };
        item.set_pinned(pinned, now());
        self.save_metadata()?;
        Ok(true)
    }

    pub fn delete(&mut self, id: &str) -> Result<bool, String> {
        let Some(index) = self.items.iter().position(|item| item.id() == id) else { return Ok(false); };
        let item = self.items.remove(index);
        self.save_metadata()?;
        self.delete_content(&item);
        Ok(true)
    }

    pub fn delete_many(&mut self, ids: &[String]) -> Result<usize, String> {
        let mut removed = vec![];
        self.items.retain(|item| { if ids.iter().any(|id| id == item.id()) { removed.push(item.clone()); false } else { true } });
        if !removed.is_empty() { self.save_metadata()?; for item in &removed { self.delete_content(item); } }
        Ok(removed.len())
    }

    pub fn clear(&mut self, history_type: Option<&str>) -> Result<(), String> {
        let mut removed = vec![];
        self.items.retain(|item| { if history_type.is_none_or(|kind| kind == "all" || kind == item.kind()) { removed.push(item.clone()); false } else { true } });
        if !removed.is_empty() { self.save_metadata()?; for item in &removed { self.delete_content(item); } }
        Ok(())
    }

    pub fn stats(&self) -> StorageStats {
        StorageStats {
            total_items: self.items.len(),
            text_items: self.items.iter().filter(|v| v.kind()=="text").count(),
            image_items: self.items.iter().filter(|v| v.kind()=="image").count(),
            file_items: self.items.iter().filter(|v| v.kind()=="file").count(),
            image_bytes: self.items.iter().map(|v| if let StoredItem::Image{byte_size,..}=v {*byte_size} else {0}).sum(),
        }
    }

    pub fn update_settings(&mut self, patch: EditableSettingsPatch) -> Result<AppSettings, String> {
        if let Some(v)=patch.capture_enabled { self.settings.capture_enabled=v; }
        if let Some(v)=patch.max_items.filter(|v| (10..=10_000).contains(v)) { self.settings.max_items=v; }
        if let Some(v)=patch.retention_days.filter(|v| (1..=365).contains(v)) { self.settings.retention_days=v; }
        if let Some(v)=patch.max_text_length.filter(|v| (1..=5_000_000).contains(v)) { self.settings.max_text_length=v; }
        if let Some(v)=patch.max_image_bytes.filter(|v| (1024*1024..=50*1024*1024).contains(v)) { self.settings.max_image_bytes=v; }
        if let Some(v)=patch.hotkey.filter(|v| !v.trim().is_empty()) { self.settings.hotkey=v; }
        if let Some(v)=patch.sensitive_filter_enabled { self.settings.sensitive_filter_enabled=v; }
        write_atomic_json(&self.root.join("settings.json"), &self.settings)?;
        self.enforce_retention()?;
        Ok(self.settings.clone())
    }

    pub fn set_startup(&mut self, enabled: bool) -> Result<(), String> {
        self.settings.launch_at_startup = enabled;
        self.settings.startup_decision_version = 1;
        write_atomic_json(&self.root.join("settings.json"), &self.settings)
    }

    pub fn add_text(&mut self, text: String) -> Result<bool, String> {
        let text = text.trim_end_matches('\0').to_string();
        if text.trim().is_empty() || text.chars().count() > self.settings.max_text_length { return Ok(false); }
        if self.settings.sensitive_filter_enabled && looks_sensitive(text.trim()) { return Ok(false); }
        let hash = hash("text", text.as_bytes());
        if let Some(existing) = self.items.iter_mut().find(|item| item.kind()=="text" && item.hash()==hash) {
            existing.touch(now()); self.save_metadata()?; return Ok(true);
        }
        let id = Uuid::new_v4().to_string();
        let content_key = format!("{id}.text");
        self.write_vault(&content_key, text.as_bytes())?;
        let timestamp = now();
        self.items.push(StoredItem::Text { id, hash, content_key, created_at:timestamp.clone(), updated_at:timestamp, pinned:false, copy_count:1 });
        self.enforce_retention()?;
        self.save_metadata()?;
        Ok(true)
    }

    pub fn add_image(&mut self, png: Vec<u8>, width: u32, height: u32) -> Result<bool, String> {
        if png.is_empty() || png.len() > self.settings.max_image_bytes { return Ok(false); }
        let hash = hash("image", &png);
        if let Some(existing) = self.items.iter_mut().find(|item| item.kind()=="image" && item.hash()==hash) {
            existing.touch(now()); self.save_metadata()?; return Ok(true);
        }
        let id = Uuid::new_v4().to_string();
        let content_key = format!("{id}.image");
        let thumbnail_key = format!("{id}.thumb");
        self.write_vault(&content_key, &png)?;
        let image = ImageReader::new(Cursor::new(&png)).with_guessed_format().map_err(|e| e.to_string())?.decode().map_err(|e| e.to_string())?;
        let thumbnail = image.thumbnail(180,180);
        let mut encoded = Cursor::new(Vec::new());
        thumbnail.write_to(&mut encoded, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        self.write_vault(&thumbnail_key, encoded.get_ref())?;
        let timestamp=now(); let byte_size=png.len() as u64;
        self.items.push(StoredItem::Image { id,hash,content_key,thumbnail_key,width,height,byte_size,created_at:timestamp.clone(),updated_at:timestamp,pinned:false,copy_count:1 });
        self.enforce_retention()?; self.save_metadata()?; Ok(true)
    }

    pub fn add_file(&mut self, path: String, byte_size: u64) -> Result<bool, String> {
        if path.trim().is_empty() { return Ok(false); }
        let hash=hash("file",path.to_lowercase().as_bytes());
        if let Some(existing)=self.items.iter_mut().find(|item| item.kind()=="file"&&item.hash()==hash) { existing.touch(now()); self.save_metadata()?; return Ok(true); }
        let id=Uuid::new_v4().to_string(); let content_key=format!("{id}.file");
        self.write_vault(&content_key, serde_json::to_string(&serde_json::json!({"path":path})).unwrap().as_bytes())?;
        let timestamp=now(); self.items.push(StoredItem::File{id,hash,content_key,byte_size,created_at:timestamp.clone(),updated_at:timestamp,pinned:false,copy_count:1});
        self.enforce_retention()?; self.save_metadata()?; Ok(true)
    }

    pub fn export_json(&self) -> Result<String, String> {
        let items=self.items.iter().filter_map(|item|self.to_public(item).ok()).collect::<Vec<_>>();
        serde_json::to_string(&serde_json::json!({"version":1,"exportedAt":now(),"items":items})).map_err(|e|e.to_string())
    }

    pub fn import_json(&mut self, input: &str) -> Result<(usize,usize),String> {
        let value:serde_json::Value=serde_json::from_str(input).map_err(|e|e.to_string())?;
        let items=value.get("items").and_then(|v|v.as_array()).ok_or("Invalid backup format")?;
        let mut imported=0; let mut skipped=0;
        for item in items { if item.get("type").and_then(|v|v.as_str())==Some("text") { if let Some(text)=item.get("text").and_then(|v|v.as_str()) { if self.add_text(text.into())? {imported+=1}else{skipped+=1} } else {skipped+=1} } else {skipped+=1} }
        Ok((imported,skipped))
    }

    fn to_public(&self, item: &StoredItem) -> Result<HistoryItem,String> {
        match item {
            StoredItem::Text{id,content_key,created_at,updated_at,pinned,copy_count,..} => Ok(HistoryItem::Text{id:id.clone(),text:String::from_utf8(self.read_vault(content_key)?).map_err(|e|e.to_string())?,created_at:created_at.clone(),updated_at:updated_at.clone(),pinned:*pinned,copy_count:*copy_count}),
            StoredItem::Image{id,thumbnail_key,width,height,byte_size,created_at,updated_at,pinned,copy_count,..} => Ok(HistoryItem::Image{id:id.clone(),thumbnail_data_url:format!("data:image/png;base64,{}",STANDARD.encode(self.read_vault(thumbnail_key)?)),width:*width,height:*height,byte_size:*byte_size,created_at:created_at.clone(),updated_at:updated_at.clone(),pinned:*pinned,copy_count:*copy_count}),
            StoredItem::File{id,content_key,byte_size,created_at,updated_at,pinned,copy_count,..} => { let value:serde_json::Value=serde_json::from_slice(&self.read_vault(content_key)?).map_err(|e|e.to_string())?; let path=value.get("path").and_then(|v|v.as_str()).ok_or("Invalid file item")?.to_string(); let p=Path::new(&path); Ok(HistoryItem::File{id:id.clone(),name:p.file_name().and_then(|v|v.to_str()).unwrap_or(&path).into(),extension:p.extension().and_then(|v|v.to_str()).unwrap_or("").to_lowercase(),missing:!p.is_file(),path,byte_size:*byte_size,created_at:created_at.clone(),updated_at:updated_at.clone(),pinned:*pinned,copy_count:*copy_count}) }
        }
    }

    fn content_path(&self,key:&str)->PathBuf { self.root.join("content").join(format!("{}.bin",key.chars().map(|c|if c.is_ascii_alphanumeric()||"_.-".contains(c){c}else{'_'}).collect::<String>())) }
    fn read_vault(&self,key:&str)->Result<Vec<u8>,String>{ decrypt_content(&fs::read(self.content_path(key)).map_err(|e|e.to_string())?,&self.key) }
    fn write_vault(&self,key:&str,data:&[u8])->Result<(),String>{ let path=self.content_path(key); let tmp=path.with_extension("bin.tmp"); fs::write(&tmp,encrypt_content(data,&self.key)?).map_err(|e|e.to_string())?; fs::rename(tmp,path).map_err(|e|e.to_string()) }
    fn save_metadata(&mut self)->Result<(),String>{ self.revision+=1; write_atomic_json(&self.root.join("history.json"),&Metadata{version:1,revision:self.revision,items:self.items.clone()}) }
    fn delete_content(&self,item:&StoredItem){ for key in item.content_keys(){ let _=fs::remove_file(self.content_path(key)); } }
    fn enforce_retention(&mut self)->Result<(),String>{ let cutoff=Utc::now()-Duration::days(self.settings.retention_days as i64); let mut removed=vec![]; self.items.retain(|item|{let keep=item.pinned()||parse_time(item.updated_at()).is_some_and(|time|time>=cutoff);if !keep{removed.push(item.clone())}keep}); self.items.sort_by(|a,b|b.updated_at().cmp(a.updated_at())); while self.items.len()>self.settings.max_items { if let Some(index)=self.items.iter().rposition(|item|!item.pinned()){removed.push(self.items.remove(index))}else{break} } for item in &removed{self.delete_content(item)} Ok(()) }
}

fn read_json<T:for<'a>Deserialize<'a>>(path:&Path)->Option<T>{serde_json::from_slice(&fs::read(path).ok()?).ok()}
fn write_atomic_json<T:Serialize>(path:&Path,value:&T)->Result<(),String>{let tmp=path.with_extension("json.tmp");fs::write(&tmp,serde_json::to_vec(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;if path.exists(){let _=fs::copy(path,path.with_extension("json.bak"));}fs::rename(tmp,path).map_err(|e|e.to_string())}
fn now()->String{Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}
fn parse_time(value:&str)->Option<DateTime<Utc>>{DateTime::parse_from_rfc3339(value).ok().map(|v|v.with_timezone(&Utc))}
fn hash(namespace:&str,data:&[u8])->String{let mut h=Sha256::new();h.update(namespace.as_bytes());h.update([0]);h.update(data);format!("{:x}",h.finalize())}

fn migrate_settings(raw:Option<StoredSettingsPatch>,evidence:InstallationEvidence)->AppSettings{
    let mut settings=AppSettings::default();
    if let Some(value)=raw.as_ref(){
        if let Some(v)=value.capture_enabled{settings.capture_enabled=v}
        if let Some(v)=value.max_items{settings.max_items=v}
        if let Some(v)=value.retention_days{settings.retention_days=v}
        if let Some(v)=value.max_text_length{settings.max_text_length=v}
        if let Some(v)=value.text_limit_migration_version{settings.text_limit_migration_version=v}else if settings.max_text_length==20_000{settings.max_text_length=1_000_000;settings.text_limit_migration_version=1}
        if let Some(v)=value.max_image_bytes{settings.max_image_bytes=v}
        if let Some(v)=value.hotkey.as_ref(){settings.hotkey=v.clone()}
        if let Some(v)=value.launch_at_startup{settings.launch_at_startup=v}
        if let Some(v)=value.startup_decision_version{settings.startup_decision_version=v}
        if let Some(v)=value.sensitive_filter_enabled{settings.sensitive_filter_enabled=v}
    }
    let has_evidence=evidence.settings_exists||evidence.history_exists||evidence.vault_key_exists||evidence.content_exists;
    if !has_evidence{
        settings.launch_at_startup=true;settings.startup_decision_version=1;settings.sensitive_filter_enabled=false;
    }else if !evidence.settings_corrupt&&raw.as_ref().and_then(|v|v.startup_decision_version)==Some(1){
        settings.startup_decision_version=1;
    }else if !evidence.settings_corrupt&&raw.as_ref().and_then(|v|v.launch_at_startup)==Some(true){
        settings.launch_at_startup=true;settings.startup_decision_version=1;settings.sensitive_filter_enabled=false;
    }else{
        settings.launch_at_startup=false;settings.startup_decision_version=0;settings.sensitive_filter_enabled=false;
    }
    settings
}

fn looks_sensitive(text:&str)->bool{
    let lower=text.to_ascii_lowercase();
    if lower.contains("-----begin ")&&lower.contains("private key-----"){return true}
    let jwt_parts:Vec<_>=text.split('.').collect();
    if jwt_parts.len()==3&&jwt_parts[0].starts_with("eyJ")&&jwt_parts.iter().all(|part|!part.is_empty()&&part.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'||c=='-')){return true}
    for label in ["password","passwd","api_key","api-key","apikey","secret","token","access_token","access-token","accesstoken"]{
        if let Some(index)=lower.find(label){if lower[index+label.len()..].trim_start().starts_with([':', '=']){return true}}
    }
    if text.len()==8&&text.chars().all(|c|c.is_ascii_digit()){return true}
    text.len()>=48&&!text.contains(char::is_whitespace)
        &&text.chars().all(|c|c.is_ascii_alphanumeric()||"+/_=-".contains(c))
        &&text.chars().any(|c|c.is_ascii_lowercase())
        &&text.chars().any(|c|c.is_ascii_uppercase())
        &&text.chars().any(|c|c.is_ascii_digit())
}

#[cfg(test)]
mod tests{
    use super::{looks_sensitive,migrate_settings,InstallationEvidence,StoredSettingsPatch};

    fn evidence()->InstallationEvidence{InstallationEvidence{settings_exists:true,settings_corrupt:false,history_exists:true,vault_key_exists:true,content_exists:true}}

    #[test]
    fn detects_the_legacy_sensitive_text_patterns(){
        for value in [
            "-----BEGIN PRIVATE KEY-----",
            "eyJhbGciOiJIUzI1NiJ9.payload.signature",
            "api_key = secret-value",
            "12345678",
            "Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
        ]{assert!(looks_sensitive(value),"expected sensitive: {value}");}
    }

    #[test]
    fn keeps_common_text_and_six_digit_numbers(){
        for value in ["normal clipboard text","123456","tracking-number-1234"]{assert!(!looks_sensitive(value),"expected safe: {value}");}
    }

    #[test]
    fn migrates_partial_settings_without_losing_existing_values(){
        let settings=migrate_settings(Some(StoredSettingsPatch{capture_enabled:Some(false),hotkey:Some("Ctrl+Shift+V".into()),launch_at_startup:Some(false),..Default::default()}),evidence());
        assert!(!settings.capture_enabled);assert_eq!(settings.hotkey,"Ctrl+Shift+V");assert!(!settings.launch_at_startup);assert_eq!(settings.startup_decision_version,0);
    }

    #[test]
    fn corrupt_existing_settings_disable_startup_and_sensitive_filter(){
        let settings=migrate_settings(None,InstallationEvidence{settings_corrupt:true,..evidence()});
        assert!(!settings.launch_at_startup);assert_eq!(settings.startup_decision_version,0);assert!(!settings.sensitive_filter_enabled);
    }

    #[test]
    fn fresh_install_keeps_the_startup_default(){
        let settings=migrate_settings(None,InstallationEvidence{settings_exists:false,settings_corrupt:false,history_exists:false,vault_key_exists:false,content_exists:false});
        assert!(settings.launch_at_startup);assert_eq!(settings.startup_decision_version,1);
    }
}
