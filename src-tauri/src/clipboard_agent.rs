use crate::{model::BackgroundState,store::HistoryStore};
use arboard::Clipboard;
use image::{DynamicImage,RgbaImage};
use serde_json::Value;
use sha2::{Digest,Sha256};
use std::{io::{BufReader,Cursor,Read},path::PathBuf,process::{Command,Stdio},sync::{mpsc,Arc,Mutex},thread,time::{Duration,SystemTime,UNIX_EPOCH}};

const MAX_FRAME:usize=64*1024*1024;
const HEARTBEAT_TIMEOUT:Duration=Duration::from_secs(12);
const FALLBACK_INTERVAL:Duration=Duration::from_millis(250);

#[derive(Default)]
struct Fingerprints{text:Option<Vec<u8>>,image:Option<Vec<u8>>,files:Option<Vec<u8>>}

#[derive(PartialEq)]
enum FrameOutcome{Ready,Heartbeat,Gap,Snapshot,Error,Other}

pub fn start(helper:PathBuf,store:Arc<Mutex<HistoryStore>>,background:Arc<Mutex<BackgroundState>>){
    thread::spawn(move||{
        let mut fingerprints=Fingerprints::default();
        loop{
            set_mode(&background,"starting",None);
            let mut child=match Command::new(&helper).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x0800_0000).spawn(){
                Ok(child)=>child,
                Err(error)=>{let message=format!("clipboard helper start failed: {error}");set_error(&background,message);set_mode(&background,"fallback",None);fallback_for(&store,&mut fingerprints,Duration::from_secs(5));continue;}
            };
            let pid=child.id();
            {let mut state=background.lock().unwrap();state.helper_pid=Some(pid);state.helper_generation+=1;state.last_error=None;}
            let stdout=child.stdout.take().unwrap();
            let(tx,rx)=mpsc::channel();
            let reader=thread::spawn(move||read_frames(stdout,tx));
            loop{
                match rx.recv_timeout(HEARTBEAT_TIMEOUT){
                    Ok(Ok(frame))=>match handle_frame(&frame,&store,&background,&mut fingerprints){
                        Ok(FrameOutcome::Ready)=>{set_mode(&background,"listening",Some(pid));let _=reconcile_clipboard(&store,&mut fingerprints);}
                        Ok(FrameOutcome::Gap|FrameOutcome::Error)=>{let _=reconcile_clipboard(&store,&mut fingerprints);}
                        Ok(_)=>{}
                        Err(error)=>set_error(&background,error),
                    },
                    Ok(Err(error))=>{set_error(&background,error);break;}
                    Err(mpsc::RecvTimeoutError::Timeout)=>{set_error(&background,"clipboard helper heartbeat timed out".into());let _=child.kill();break;}
                    Err(mpsc::RecvTimeoutError::Disconnected)=>break,
                }
            }
            let _=child.kill();
            let status=child.wait().ok();
            let _=reader.join();
            {let mut state=background.lock().unwrap();state.helper_pid=None;state.mode="fallback".into();state.restart_count+=1;state.last_exit=status.map(|value|serde_json::json!({"code":value.code(),"signal":null}));}
            fallback_for(&store,&mut fingerprints,Duration::from_secs(2));
        }
    });
}

pub fn reconcile_now(store:&Arc<Mutex<HistoryStore>>)->Result<(),String>{reconcile_clipboard(store,&mut Fingerprints::default())}

fn read_frames(stdout:impl Read,tx:mpsc::Sender<Result<Vec<u8>,String>>){
    let mut reader=BufReader::new(stdout);
    loop{
        let mut length_bytes=[0u8;4];
        if let Err(error)=reader.read_exact(&mut length_bytes){let _=tx.send(Err(format!("clipboard helper output ended: {error}")));return;}
        let frame_length=u32::from_le_bytes(length_bytes)as usize;
        if !(4..=MAX_FRAME).contains(&frame_length){let _=tx.send(Err("invalid clipboard frame length".into()));return;}
        let mut frame=vec![0u8;frame_length];
        if let Err(error)=reader.read_exact(&mut frame){let _=tx.send(Err(format!("clipboard frame is truncated: {error}")));return;}
        if tx.send(Ok(frame)).is_err(){return;}
    }
}

fn handle_frame(frame:&[u8],store:&Arc<Mutex<HistoryStore>>,background:&Arc<Mutex<BackgroundState>>,fingerprints:&mut Fingerprints)->Result<FrameOutcome,String>{
    if frame.len()<4{return Err("clipboard frame is truncated".into())}
    let header_length=u32::from_le_bytes(frame[..4].try_into().unwrap())as usize;
    if header_length>frame.len()-4{return Err("clipboard header is invalid".into())}
    let header:Value=serde_json::from_slice(&frame[4..4+header_length]).map_err(|error|error.to_string())?;
    let kind=header.get("type").and_then(Value::as_str).ok_or("clipboard frame type is missing")?;
    let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()as u64;
    {let mut state=background.lock().unwrap();state.last_event_at=Some(now);state.last_sequence=header.get("sequence").and_then(Value::as_u64);if kind=="gap"{state.gap_count+=1}}
    let outcome=match kind{"ready"=>FrameOutcome::Ready,"heartbeat"=>FrameOutcome::Heartbeat,"gap"=>FrameOutcome::Gap,"error"=>FrameOutcome::Error,"snapshot"=>FrameOutcome::Snapshot,_=>FrameOutcome::Other};
    if outcome!=FrameOutcome::Snapshot{return Ok(outcome)}
    let payload=&frame[4+header_length..];
    let segment=|name:&str|->Result<Option<&[u8]>,String>{let Some(value)=header.get(name)else{return Ok(None)};let offset=value.get("offset").and_then(Value::as_u64).ok_or("invalid segment offset")?as usize;let length=value.get("length").and_then(Value::as_u64).ok_or("invalid segment length")?as usize;payload.get(offset..offset.saturating_add(length)).map(Some).ok_or("clipboard segment exceeds payload".into())};
    let mut locked=store.lock().map_err(|_|"history store lock failed")?;
    if !locked.settings.capture_enabled{return Ok(outcome)}
    if let Some(bytes)=segment("text")?{fingerprints.text=Some(digest(bytes));locked.add_text(String::from_utf8(bytes.to_vec()).map_err(|error|error.to_string())?)?;}
    if let Some(png)=segment("png")?{fingerprints.image=Some(digest(png));let dimensions=header.get("png").unwrap();let width=dimensions.get("width").and_then(Value::as_u64).ok_or("image width missing")?as u32;let height=dimensions.get("height").and_then(Value::as_u64).ok_or("image height missing")?as u32;locked.add_image(png.to_vec(),width,height)?;}
    if let Some(bytes)=segment("files")?{let files:Vec<Value>=serde_json::from_slice(bytes).map_err(|error|error.to_string())?;let parsed=files.iter().filter_map(|file|Some((file.get("path")?.as_str()?.to_string(),file.get("byteSize")?.as_u64()?))).collect::<Vec<_>>();fingerprints.files=Some(file_fingerprint(&parsed));for(path,size)in parsed{locked.add_file(path,size)?;}}
    Ok(outcome)
}

fn fallback_for(store:&Arc<Mutex<HistoryStore>>,fingerprints:&mut Fingerprints,duration:Duration){
    let deadline=std::time::Instant::now()+duration;
    while std::time::Instant::now()<deadline{let _=reconcile_clipboard(store,fingerprints);thread::sleep(FALLBACK_INTERVAL);}
}

fn reconcile_clipboard(store:&Arc<Mutex<HistoryStore>>,fingerprints:&mut Fingerprints)->Result<(),String>{
    let capture_enabled=store.lock().map_err(|_|"history store lock failed")?.settings.capture_enabled;
    if !capture_enabled{return Ok(())}
    let mut clipboard=Clipboard::new().map_err(|error|error.to_string())?;
    if let Ok(text)=clipboard.get_text(){let fingerprint=digest(text.as_bytes());if fingerprints.text.as_ref()!=Some(&fingerprint){fingerprints.text=Some(fingerprint);store.lock().map_err(|_|"history store lock failed")?.add_text(text)?;}}
    if let Ok(image)=clipboard.get_image(){let bytes=image.bytes.into_owned();let fingerprint=digest(&bytes);if fingerprints.image.as_ref()!=Some(&fingerprint){let rgba=RgbaImage::from_raw(image.width as u32,image.height as u32,bytes).ok_or("clipboard image dimensions are invalid")?;let mut encoded=Cursor::new(Vec::new());DynamicImage::ImageRgba8(rgba).write_to(&mut encoded,image::ImageFormat::Png).map_err(|error|error.to_string())?;fingerprints.image=Some(fingerprint);store.lock().map_err(|_|"history store lock failed")?.add_image(encoded.into_inner(),image.width as u32,image.height as u32)?;}}
    if let Ok(paths)=clipboard_win::get_clipboard::<Vec<PathBuf>,_>(clipboard_win::formats::FileList){let files=paths.into_iter().filter_map(|path|Some((path.to_string_lossy().into_owned(),path.metadata().ok()?.len()))).collect::<Vec<_>>();let fingerprint=file_fingerprint(&files);if fingerprints.files.as_ref()!=Some(&fingerprint){fingerprints.files=Some(fingerprint);let mut locked=store.lock().map_err(|_|"history store lock failed")?;for(path,size)in files{locked.add_file(path,size)?;}}}else{fingerprints.files=None;}
    Ok(())
}

fn digest(bytes:&[u8])->Vec<u8>{Sha256::digest(bytes).to_vec()}
fn file_fingerprint(files:&[(String,u64)])->Vec<u8>{let mut hash=Sha256::new();for(path,size)in files{hash.update(path.to_lowercase().as_bytes());hash.update([0]);hash.update(size.to_le_bytes());}hash.finalize().to_vec()}
fn set_mode(background:&Arc<Mutex<BackgroundState>>,mode:&str,pid:Option<u32>){if let Ok(mut state)=background.lock(){state.mode=mode.into();state.helper_pid=pid;}}
fn set_error(background:&Arc<Mutex<BackgroundState>>,error:String){log::error!("{error}");if let Ok(mut state)=background.lock(){state.last_error=Some(error)}}

#[cfg(windows)]
trait WindowsCommandExt{fn creation_flags(&mut self,flags:u32)->&mut Self;}
#[cfg(windows)]
impl WindowsCommandExt for Command{fn creation_flags(&mut self,flags:u32)->&mut Self{use std::os::windows::process::CommandExt;CommandExt::creation_flags(self,flags);self}}

#[cfg(test)]
mod tests{
    use super::*;
    use std::io::Cursor;

    fn control_frame(kind:&str)->Vec<u8>{
        let header=serde_json::to_vec(&serde_json::json!({"version":1,"type":kind,"toSequence":2,"dropped":1,"reason":"sequence-advanced","at":1})).unwrap();
        let mut frame=(header.len()as u32).to_le_bytes().to_vec();frame.extend_from_slice(&header);frame
    }

    #[test]
    fn frame_reader_delivers_a_complete_frame_and_reports_eof(){
        let frame=control_frame("gap");let mut encoded=(frame.len()as u32).to_le_bytes().to_vec();encoded.extend_from_slice(&frame);
        let(tx,rx)=mpsc::channel();read_frames(Cursor::new(encoded),tx);
        assert_eq!(rx.recv().unwrap().unwrap(),frame);assert!(rx.recv().unwrap().is_err());
    }

    #[test]
    fn gap_frames_update_health_state(){
        let root=std::env::temp_dir().join(format!("history-clipboard-agent-test-{}",uuid::Uuid::new_v4()));
        let store=Arc::new(Mutex::new(HistoryStore::load(root.clone()).unwrap()));
        let background=Arc::new(Mutex::new(BackgroundState::default()));
        let outcome=handle_frame(&control_frame("gap"),&store,&background,&mut Fingerprints::default()).unwrap();
        assert!(outcome==FrameOutcome::Gap);assert_eq!(background.lock().unwrap().gap_count,1);
        let _=std::fs::remove_dir_all(root);
    }

    #[test]
    fn file_fingerprints_include_paths_and_sizes(){
        let first=file_fingerprint(&[("C:\\a.txt".into(),10)]);
        assert_eq!(first,file_fingerprint(&[("c:\\A.TXT".into(),10)]));
        assert_ne!(first,file_fingerprint(&[("C:\\a.txt".into(),11)]));
    }
}
