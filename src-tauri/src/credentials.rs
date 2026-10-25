use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("credentials");
    if path.exists()
        && fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("凭据目录不能是符号链接".into());
    }
    fs::create_dir_all(&path).map_err(|_| "无法创建本地凭据目录")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法设置凭据目录权限")?;
    }
    Ok(path)
}

pub fn load(app: &tauri::AppHandle) -> Result<BTreeMap<String, String>, String> {
    let path = directory(app)?.join("auth.json");
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("无法读取本地凭据，请检查文件权限；不会访问系统钥匙串".into()),
    };
    let metadata = file.metadata().map_err(|_| "无法检查凭据文件")?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("凭据文件格式或大小异常".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "无法设置凭据文件权限")?;
    }
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|_| "无法读取凭据文件")?;
    serde_json::from_str(&content)
        .map_err(|_| "本地凭据文件损坏，请修复 auth.json 后重试；原文件未被覆盖".into())
}

pub fn save(app: &tauri::AppHandle, entries: &BTreeMap<String, String>) -> Result<(), String> {
    let directory = directory(app)?;
    let temporary = directory.join(format!(
        ".auth-{}-{}.tmp",
        std::process::id(),
        NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = write_atomic(&temporary, &directory.join("auth.json"), entries);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| "保存本地凭据失败，原有文件保留；请检查可用空间与目录权限".into())
}

fn write_atomic(
    temporary: &Path,
    destination: &Path,
    entries: &BTreeMap<String, String>,
) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(temporary)?;
    let content = serde_json::to_vec_pretty(entries)?;
    if content.len() > 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "credential size limit",
        ));
    }
    file.write_all(&content)?;
    file.sync_all()?;
    fs::rename(temporary, destination)?;
    Ok(())
}

pub fn inject(app: &tauri::AppHandle, method: &str, params: &mut Value) -> Result<(), String> {
    if !matches!(
        method,
        "agent.send" | "agent.continue" | "providers.test" | "providers.capabilities"
    ) {
        return Ok(());
    }
    let provider = params
        .get("providerId")
        .and_then(Value::as_str)
        .ok_or("请先选择供应商")?;
    let entries = load(app)?;
    let key = entries.get(provider).ok_or("此供应商尚未保存本地凭据。请在设置中重新录入一次；之后无需钥匙串授权。本机无密钥服务也请保存一次。")?;
    params["apiKey"] = Value::String(key.clone());
    Ok(())
}
