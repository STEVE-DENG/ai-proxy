use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "com.nekoya.ai-proxy";
const NETWORKSETUP: &str = "/usr/sbin/networksetup";

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    let result = unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    if result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            eprintln!("[engine] 清理进程组 {pid} 失败: {error}");
        }
    }
}

struct PendingReply {
    sender: mpsc::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct Engine {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, PendingReply>>>,
    next_id: AtomicU64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyEndpoint {
    enabled: bool,
    server: String,
    port: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxySnapshot {
    service: String,
    web: ProxyEndpoint,
    secure: ProxyEndpoint,
    applied_port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProxyStatus {
    active: bool,
    service: Option<String>,
    server: Option<String>,
    port: Option<u16>,
    can_restore: bool,
}

#[derive(Default)]
struct AppState {
    engine: Engine,
    proxy_snapshot: Mutex<Option<ProxySnapshot>>,
}

impl Engine {
    fn emit_event(app: &AppHandle, value: &Value) {
        let event = value
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("engine");
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let _ = app.emit(event, data);
    }

    fn start(app: &AppHandle, state: &AppState) -> Result<(), String> {
        let mut child_slot = state.engine.child.lock().map_err(|e| e.to_string())?;
        if child_slot.is_some() {
            return Ok(());
        }

        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
        std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;

        let mut command = engine_command(app)?;
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .env("AI_PROXY_APP_DATA", &app_data)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|e| format!("启动本地引擎失败: {e}"))?;
        let stdout = child.stdout.take().ok_or("引擎 stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("引擎 stderr 不可用")?;
        let stdin = child.stdin.take().ok_or("引擎 stdin 不可用")?;
        *state.engine.stdin.lock().map_err(|e| e.to_string())? = Some(stdin);
        *child_slot = Some(child);

        let app_stdout = app.clone();
        let pending = state.engine.pending.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    let _ = app_stdout.emit("engine-log", line);
                    continue;
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("response") => {
                        let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
                        let result = if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        } else {
                            Err(value
                                .get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("引擎请求失败")
                                .to_string())
                        };
                        if let Some(reply) = pending.lock().unwrap().remove(&id) {
                            let _ = reply.sender.send(result);
                        }
                    }
                    Some("event") => Engine::emit_event(&app_stdout, &value),
                    Some("ready") => {
                        let _ = app_stdout.emit("engine-ready", &value);
                    }
                    _ => {}
                }
            }
            let _ = app_stdout.emit("engine-exit", json!({"message": "本地引擎已退出"}));
        });

        let app_stderr = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[engine] {line}");
                let _ = app_stderr.emit("engine-log", line);
            }
        });

        Ok(())
    }

    fn call(
        app: &AppHandle,
        state: &AppState,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        Self::start(app, state)?;
        let id = state.engine.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        state
            .engine
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, PendingReply { sender: tx });
        let payload = json!({"id": id, "method": method, "params": params});
        {
            let mut stdin = state.engine.stdin.lock().map_err(|e| e.to_string())?;
            let writer = stdin.as_mut().ok_or("本地引擎未运行")?;
            writeln!(writer, "{}", payload).map_err(|e| format!("写入引擎失败: {e}"))?;
            writer.flush().map_err(|e| e.to_string())?;
        }
        match rx.recv_timeout(Duration::from_secs(90)) {
            Ok(result) => result,
            Err(_) => {
                state.engine.pending.lock().unwrap().remove(&id);
                Err(format!("引擎请求超时: {method}"))
            }
        }
    }

    fn shutdown(&self) {
        let stdin = self.stdin.lock().ok().and_then(|mut slot| slot.take());
        if let Some(mut writer) = stdin {
            let _ = writeln!(writer, "{}", json!({"method": "__shutdown__"}));
            let _ = writer.flush();
        }

        let child = self.child.lock().ok().and_then(|mut slot| slot.take());
        let Some(mut child) = child else {
            return;
        };
        let pid = child.id();

        // The PyInstaller one-file bootloader runs the Python app as a child.
        // Wait briefly for a graceful exit, then terminate the whole group.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => break,
            }
        }

        #[cfg(unix)]
        signal_process_group(pid, libc::SIGTERM);
        std::thread::sleep(Duration::from_millis(500));

        #[cfg(unix)]
        signal_process_group(pid, libc::SIGKILL);
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

fn engine_command(app: &AppHandle) -> Result<Command, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let project_root = manifest.parent().ok_or("项目路径异常")?;
    let engine_dir = project_root.join("engine");
    let venv_python = engine_dir.join(".venv/bin/python");

    if cfg!(debug_assertions) && venv_python.exists() {
        let mut command = Command::new(venv_python);
        command
            .current_dir(&engine_dir)
            .arg("-m")
            .arg("ai_proxy_engine");
        return Ok(command);
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let sidecar = exe
        .parent()
        .ok_or("无法定位应用目录")?
        .join("ai-proxy-engine");
    if sidecar.exists() {
        return Ok(Command::new(sidecar));
    }

    if cfg!(debug_assertions) {
        let mut command = Command::new("uv");
        command.current_dir(&engine_dir).args([
            "run",
            "--project",
            ".",
            "python",
            "-m",
            "ai_proxy_engine",
        ]);
        return Ok(command);
    }
    let _ = app;
    Err("应用内缺少 ai-proxy-engine，请先运行 npm run engine:freeze".into())
}

#[tauri::command]
async fn engine_call(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let app2 = app.clone();
    let method2 = method.clone();
    let _ = state;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app2.state::<AppState>();
        Engine::call(&app2, &state, &method2, params.unwrap_or(json!({})))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn pick_local_file() -> Option<String> {
    rfd::FileDialog::new()
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn secret_set(account: String, secret: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("执行 {program} 失败: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn admin_networksetup(args: &[&str]) -> Result<(), String> {
    let command = format!(
        "{} {}",
        shell_quote(NETWORKSETUP),
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    run_command("osascript", &["-e", &script]).map(|_| ())
}

fn active_service() -> Result<String, String> {
    let route = run_command("/sbin/route", &["-n", "get", "default"]).unwrap_or_default();
    let device = route
        .lines()
        .find_map(|line| line.trim().strip_prefix("interface: "))
        .unwrap_or("en0")
        .trim()
        .to_string();
    let output = run_command(NETWORKSETUP, &["-listnetworkserviceorder"])?;
    let mut current = String::new();
    for line in output.lines() {
        if let Some(name) = line
            .trim()
            .strip_prefix(|c: char| c == '(' || c.is_ascii_digit())
        {
            let _ = name;
        }
        if line.trim_start().starts_with('(') {
            if let Some(end) = line.find(')') {
                current = line[end + 1..].trim().to_string();
            }
        }
        if line.contains(&format!("Device: {device})")) && !current.is_empty() {
            return Ok(current);
        }
    }
    let output = run_command(NETWORKSETUP, &["-listallnetworkservices"])?;
    for preferred in ["Wi-Fi", "Ethernet"] {
        if output.lines().any(|line| line.trim() == preferred) {
            return Ok(preferred.to_string());
        }
    }
    Err("没有找到可用的网络服务".into())
}

fn parse_proxy_output(output: &str) -> ProxyEndpoint {
    let field = |name: &str| {
        output
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_once(':'))
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default()
    };
    ProxyEndpoint {
        enabled: field("Enabled") == "Yes",
        server: field("Server"),
        port: field("Port"),
    }
}

fn read_proxy(service: &str) -> Result<(ProxyEndpoint, ProxyEndpoint), String> {
    let web = run_command(NETWORKSETUP, &["-getwebproxy", service])?;
    let secure = run_command(NETWORKSETUP, &["-getsecurewebproxy", service])?;
    Ok((parse_proxy_output(&web), parse_proxy_output(&secure)))
}

#[tauri::command]
fn local_proxy_status(state: State<'_, AppState>) -> Result<LocalProxyStatus, String> {
    let snapshot = state
        .proxy_snapshot
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let service = active_service().ok();
    let endpoint = service
        .as_deref()
        .and_then(|service| read_proxy(service).ok());
    let port = endpoint
        .as_ref()
        .and_then(|(web, _)| web.port.parse::<u16>().ok());
    let active = endpoint
        .as_ref()
        .map(|(web, _)| {
            web.enabled
                && web.server == "127.0.0.1"
                && snapshot
                    .as_ref()
                    .is_none_or(|value| web.port == value.applied_port.to_string())
        })
        .unwrap_or(false);
    Ok(LocalProxyStatus {
        active,
        service,
        server: endpoint.map(|(web, _)| web.server),
        port,
        can_restore: snapshot.is_some(),
    })
}

#[tauri::command]
fn local_proxy_enable(port: u16, state: State<'_, AppState>) -> Result<LocalProxyStatus, String> {
    let service = active_service()?;
    let (web, secure) = read_proxy(&service)?;
    let mut snapshot = state.proxy_snapshot.lock().map_err(|e| e.to_string())?;
    if snapshot.is_none() {
        *snapshot = Some(ProxySnapshot {
            service: service.clone(),
            web,
            secure,
            applied_port: port,
        });
    } else if let Some(value) = snapshot.as_mut() {
        value.applied_port = port;
    }
    let port_text = port.to_string();
    admin_networksetup(&[
        "-setwebproxy",
        &service,
        "127.0.0.1",
        &port_text,
        "off",
        "",
        "",
    ])?;
    admin_networksetup(&[
        "-setsecurewebproxy",
        &service,
        "127.0.0.1",
        &port_text,
        "off",
        "",
        "",
    ])?;
    drop(snapshot);
    local_proxy_status(state)
}

#[tauri::command]
fn local_proxy_disable(state: State<'_, AppState>) -> Result<LocalProxyStatus, String> {
    restore_system_proxy(&state, false)?;
    local_proxy_status(state)
}

#[tauri::command]
fn local_proxy_restore(state: State<'_, AppState>) -> Result<LocalProxyStatus, String> {
    restore_system_proxy(&state, true)?;
    local_proxy_status(state)
}

fn restore_system_proxy(state: &AppState, force: bool) -> Result<(), String> {
    let snapshot = state
        .proxy_snapshot
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let Some(snapshot) = snapshot else {
        if force {
            let service = active_service()?;
            admin_networksetup(&["-setwebproxystate", &service, "off"])?;
            admin_networksetup(&["-setsecurewebproxystate", &service, "off"])?;
        }
        return Ok(());
    };
    let (current, _) = read_proxy(&snapshot.service)?;
    if !force && !current.enabled {
        *state.proxy_snapshot.lock().unwrap() = None;
        return Ok(());
    }
    if !force
        && current.enabled
        && (current.server != "127.0.0.1" || current.port != snapshot.applied_port.to_string())
    {
        *state.proxy_snapshot.lock().unwrap() = None;
        return Ok(());
    }

    for (flag, endpoint) in [
        ("-setwebproxy", &snapshot.web),
        ("-setsecurewebproxy", &snapshot.secure),
    ] {
        if endpoint.enabled {
            admin_networksetup(&[
                flag,
                &snapshot.service,
                &endpoint.server,
                &endpoint.port,
                "off",
                "",
                "",
            ])?;
        } else {
            let state_flag = if flag == "-setwebproxy" {
                "-setwebproxystate"
            } else {
                "-setsecurewebproxystate"
            };
            admin_networksetup(&[state_flag, &snapshot.service, "off"])?;
        }
    }
    *state.proxy_snapshot.lock().unwrap() = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            engine_call,
            pick_local_file,
            secret_set,
            secret_get,
            secret_delete,
            local_proxy_status,
            local_proxy_enable,
            local_proxy_disable,
            local_proxy_restore,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<AppState>();
                if let Err(error) = Engine::start(&handle, &state) {
                    let _ = handle.emit("engine-boot-error", error);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = handle.state::<AppState>();
            let _ = restore_system_proxy(&state, false);
            state.engine.shutdown();
        }
    });
}
