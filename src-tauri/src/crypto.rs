use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde_json::Value;
use std::{ffi::c_void, fs, path::Path, ptr};

#[repr(C)]
struct DataBlob { size: u32, data: *mut u8 }

#[link(name = "Crypt32")]
unsafe extern "system" {
    fn CryptUnprotectData(input: *mut DataBlob, description: *mut *mut u16, entropy: *mut DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
    fn CryptProtectData(input: *mut DataBlob, description: *const u16, entropy: *mut DataBlob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut DataBlob) -> i32;
}
#[link(name = "Kernel32")]
unsafe extern "system" { fn LocalFree(memory: *mut c_void) -> *mut c_void; }

fn dpapi_unprotect(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut source = input.to_vec();
    let mut source_blob = DataBlob { size: source.len() as u32, data: source.as_mut_ptr() };
    let mut output = DataBlob { size: 0, data: ptr::null_mut() };
    let ok = unsafe { CryptUnprotectData(&mut source_blob, ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), 0, &mut output) };
    if ok == 0 { return Err("Windows DPAPI could not decrypt the key".into()); }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data.cast()); }
    Ok(bytes)
}

fn dpapi_protect(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut source = input.to_vec();
    let mut source_blob = DataBlob { size: source.len() as u32, data: source.as_mut_ptr() };
    let mut output = DataBlob { size: 0, data: ptr::null_mut() };
    let ok = unsafe { CryptProtectData(&mut source_blob, ptr::null(), ptr::null_mut(), ptr::null_mut(), ptr::null_mut(), 0, &mut output) };
    if ok == 0 { return Err("Windows DPAPI could not protect the key".into()); }
    let bytes = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data.cast()); }
    Ok(bytes)
}

fn aes_decrypt(key: &[u8], nonce: &[u8], ciphertext_and_tag: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid AES key")?;
    cipher.decrypt(Nonce::from_slice(nonce), ciphertext_and_tag).map_err(|_| "AES-GCM authentication failed".into())
}

pub fn load_or_create_content_key(root: &Path) -> Result<[u8; 32], String> {
    let key_path = root.join("vault.key");
    if key_path.exists() {
        let encrypted = fs::read(&key_path).map_err(|e| e.to_string())?;
        let decoded = if encrypted.starts_with(b"v10") {
            let state: Value = serde_json::from_slice(&fs::read(root.join("Local State")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let encoded = state.pointer("/os_crypt/encrypted_key").and_then(Value::as_str).ok_or("Chromium encryption key is missing")?;
            let wrapped = STANDARD.decode(encoded).map_err(|e| e.to_string())?;
            if !wrapped.starts_with(b"DPAPI") { return Err("Unsupported Chromium key format".into()); }
            let master = dpapi_unprotect(&wrapped[5..])?;
            if encrypted.len() < 31 { return Err("Invalid Chromium vault key".into()); }
            aes_decrypt(&master, &encrypted[3..15], &encrypted[15..])?
        } else if encrypted.starts_with(b"HCDP1") {
            dpapi_unprotect(&encrypted[5..])?
        } else { return Err("Unsupported vault key format".into()); };
        let raw = STANDARD.decode(String::from_utf8(decoded).map_err(|_| "Vault key is not UTF-8")?).map_err(|e| e.to_string())?;
        return raw.try_into().map_err(|_| "Vault key must contain 32 bytes".into());
    }

    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    rand::rng().fill_bytes(&mut key);
    let protected = dpapi_protect(STANDARD.encode(key).as_bytes())?;
    let mut payload = b"HCDP1".to_vec();
    payload.extend_from_slice(&protected);
    fs::write(key_path, payload).map_err(|e| e.to_string())?;
    Ok(key)
}

pub fn decrypt_content(payload: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if payload.len() < 32 || &payload[..4] != b"HCB1" { return Err("Invalid encrypted content".into()); }
    let mut ciphertext_and_tag = payload[32..].to_vec();
    ciphertext_and_tag.extend_from_slice(&payload[16..32]);
    aes_decrypt(key, &payload[4..16], &ciphertext_and_tag)
}

pub fn encrypt_content(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut nonce_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid AES key")?;
    let mut encrypted = cipher.encrypt(Nonce::from_slice(&nonce_bytes), data).map_err(|_| "content encryption failed")?;
    let tag = encrypted.split_off(encrypted.len() - 16);
    let mut output = b"HCB1".to_vec();
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&tag);
    output.extend_from_slice(&encrypted);
    Ok(output)
}
