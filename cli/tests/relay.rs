//! Integration tests: run `bctl proxy` as a child process (temp BCTL_CONFIG_DIR, free port) and talk to it
//! with fake extension / CLI clients.
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::TcpStream;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use tungstenite::{client::IntoClientRequest, Message, WebSocket};

const SECRET: &str = "test-secret";
const EXT_ORIGIN: &str = "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm";
type Ws = WebSocket<TcpStream>;

struct Proxy {
    child: Child,
    port: u16,
    dir: std::path::PathBuf,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

#[allow(clippy::zombie_processes)]
fn start(extra: &[&str]) -> Proxy {
    // Picking a free port is racy across parallel tests: retry if our proxy died (e.g. port taken).
    for _ in 0..5 {
        if let Some(p) = try_start(extra) {
            return p;
        }
    }
    panic!("proxy did not start");
}

#[allow(clippy::zombie_processes)]
fn try_start(extra: &[&str]) -> Option<Proxy> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dir = std::env::temp_dir().join(format!("bctl-test-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        json!({"secret":SECRET,"port":port}).to_string(),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("proxy")
        .args(extra)
        .env("BCTL_CONFIG_DIR", &dir)
        .env("BCTL_EXT_WAIT_MS", "400")
        .env_remove("BCTL_PORT")
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut p = Proxy { child, port, dir };
    for _ in 0..100 {
        if p.child.try_wait().unwrap().is_some() {
            return None;
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            std::thread::sleep(Duration::from_millis(30));
            if p.child.try_wait().unwrap().is_none() {
                return Some(p);
            }
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn mac(msg: &str) -> String {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(SECRET.as_bytes()).unwrap();
    m.update(msg.as_bytes());
    hex::encode(m.finalize().into_bytes())
}
fn recv(ws: &mut Ws) -> Value {
    loop {
        if let Message::Text(t) = ws.read().expect("read") {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}
fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::text(v.to_string())).unwrap();
}

/// Full handshake; Err(text) if rejected at upgrade or by an `error` message.
fn try_connect(port: u16, role: &str, origin: Option<&str>, secret_mac_ok: bool) -> Result<Ws, String> {
    let info = json!({"browser":"Test Chrome 1","extVersion":"9.9.9"});
    try_connect_info(port, role, origin, secret_mac_ok, info)
}
fn try_connect_info(
    port: u16,
    role: &str,
    origin: Option<&str>,
    secret_mac_ok: bool,
    info: Value,
) -> Result<Ws, String> {
    let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut req = format!("ws://127.0.0.1:{port}/").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    let (mut ws, _) = tungstenite::client(req, s).map_err(|e| e.to_string())?;
    let np = recv(&mut ws)["nonce"].as_str().unwrap().to_string();
    let nc = "abcd".to_string();
    let mut m = mac(&format!("bctl1|client|{role}|{np}|{nc}"));
    if !secret_mac_ok {
        m = "00".repeat(32);
    }
    send(
        &mut ws,
        json!({"t":"auth","role":role,"nonce":nc,"mac":m,"version":"t","info":info}),
    );
    let w = recv(&mut ws);
    if w["t"] == "error" {
        return Err(w["error"].as_str().unwrap().to_string());
    }
    assert_eq!(w["t"], "welcome");
    assert_eq!(w["mac"], mac(&format!("bctl1|server|{role}|{nc}|{np}")));
    Ok(ws)
}
fn cli(p: &Proxy) -> Ws {
    try_connect(p.port, "cli", None, true).unwrap()
}
fn ext(p: &Proxy) -> Ws {
    try_connect(p.port, "ext", Some(EXT_ORIGIN), true).unwrap()
}
fn status(p: &Proxy) -> Value {
    let mut c = cli(p);
    send(&mut c, json!({"t":"status"}));
    recv(&mut c)
}
fn wait_exit(p: &mut Proxy, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if p.child.try_wait().unwrap().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn handshake_and_status() {
    let p = start(&[]);
    let s = status(&p);
    assert_eq!(s["proxy"]["port"], p.port);
    assert_eq!(s["proxy"]["idleTimeoutSecs"], 600);
    assert!(s["ext"].is_null());
    let _e = ext(&p);
    assert_eq!(
        status(&p)["ext"],
        json!({"browser":"Test Chrome 1","extVersion":"9.9.9"})
    );
}

#[test]
fn rejects_bad_mac_origin_and_role() {
    let p = start(&[]);
    assert!(try_connect(p.port, "cli", None, false)
        .unwrap_err()
        .contains("authentication failed"));
    assert!(try_connect(p.port, "cli", Some("https://evil.example"), true)
        .unwrap_err()
        .contains("403"));
    assert!(try_connect(p.port, "ext", Some("https://evil.example"), true)
        .unwrap_err()
        .contains("403"));
    assert!(try_connect(p.port, "ext", None, true)
        .unwrap_err()
        .contains("authentication failed"));
    assert!(try_connect(p.port, "cli", Some(EXT_ORIGIN), true).is_err());
    // Only the pinned extension ID may be an ext.
    for o in [
        "chrome-extension://abc",
        "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbmx",
    ] {
        assert!(try_connect(p.port, "ext", Some(o), true).unwrap_err().contains("403"));
    }
}

#[test]
fn relays_request_events_and_response() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{"argv":["x"]}}));
    let r = recv(&mut e);
    assert_eq!((r["t"].as_str(), &r["req"]["argv"]), (Some("req"), &json!(["x"])));
    let id = r["id"].clone();
    send(&mut e, json!({"t":"event","id":id,"stderr":"waiting\n"}));
    send(&mut e, json!({"t":"res","id":id,"res":{"exitCode":0,"stdout":"ok\n"}}));
    assert_eq!(recv(&mut c), json!({"t":"event","stderr":"waiting\n"}));
    assert_eq!(recv(&mut c), json!({"t":"res","res":{"exitCode":0,"stdout":"ok\n"}}));
}

#[test]
fn ext_disconnect_yields_error_res() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    recv(&mut e);
    drop(e);
    let r = recv(&mut c);
    assert_eq!(r["res"]["exitCode"], 1);
    assert!(r["res"]["stderr"]
        .as_str()
        .unwrap()
        .contains("browser extension disconnected"));
}

#[test]
fn cli_disconnect_sends_cancel() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    drop(c);
    assert_eq!(recv(&mut e), json!({"t":"cancel","id":id}));
}

#[test]
fn no_extension_errors_after_wait() {
    let p = start(&[]);
    let mut c = cli(&p);
    let t = Instant::now();
    send(&mut c, json!({"t":"req","req":{}}));
    let r = recv(&mut c);
    assert!(t.elapsed() >= Duration::from_millis(350));
    assert_eq!(r["res"]["exitCode"], 1);
    assert!(r["res"]["stderr"].as_str().unwrap().contains("not connected"));
}

#[test]
fn idle_timeout_exits() {
    let mut p = start(&["--idle-timeout", "1"]);
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn shutdown_exits() {
    let mut p = start(&[]);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"shutdown"}));
    assert_eq!(recv(&mut c)["t"], "ok");
    assert!(wait_exit(&mut p, 5));
}

fn bctl(p: &Proxy, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bctl"))
        .args(args)
        .env("BCTL_CONFIG_DIR", &p.dir)
        .env("BCTL_PORT", p.port.to_string())
        .output()
        .unwrap()
}

#[test]
fn cli_binary_end_to_end() {
    let p = start(&[]);
    let mut e = ext(&p);
    let out = p.dir.join("sub/dir/f.txt");
    let path = out.to_string_lossy().to_string();
    let t = std::thread::spawn(move || {
        let r = recv(&mut e);
        assert_eq!(r["req"]["argv"], json!(["echo", "hi"]));
        assert_eq!(r["req"]["session"], "default");
        let id = r["id"].clone();
        send(&mut e, json!({"t":"event","id":id,"stderr":"progress\n"}));
        let files = json!([{"path":path,"base64":"aGVsbG8="}]);
        send(
            &mut e,
            json!({"t":"res","id":id,"res":{"exitCode":3,"stdout":"out","stderr":"err","files":files}}),
        );
        e
    });
    let o = bctl(&p, &["echo", "hi"]);
    let _e = t.join().unwrap();
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(o.stdout, b"out");
    assert_eq!(String::from_utf8_lossy(&o.stderr), "progress\nerr");
    assert_eq!(std::fs::read(&out).unwrap(), b"hello");
    let s = bctl(&p, &["status"]);
    let s = String::from_utf8_lossy(&s.stdout).to_string();
    assert!(s.contains("extension: Test Chrome 1 (extension v9.9.9)"), "{s}");
}

#[test]
fn cli_binary_unpaired_and_bad_server_mac() {
    let p = start(&[]);
    std::fs::remove_file(p.dir.join("config.json")).unwrap();
    let o = bctl(&p, &["tabs"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).starts_with("Not paired."));

    // Fake server that answers auth with a wrong welcome MAC.
    std::fs::write(p.dir.join("config.json"), json!({"secret":SECRET}).to_string()).unwrap();
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let t = std::thread::spawn(move || {
        // The CLI's liveness probe connects first without speaking WebSocket; skip it.
        let mut ws = loop {
            if let Ok(ws) = tungstenite::accept(l.accept().unwrap().0) {
                break ws;
            }
        };
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        recv(&mut ws);
        send(&mut ws, json!({"t":"welcome","mac":"00","version":"x"}));
    });
    let o = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("tabs")
        .env("BCTL_CONFIG_DIR", &p.dir)
        .env("BCTL_PORT", port.to_string())
        .output()
        .unwrap();
    t.join().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("server authentication failed"));
}

// ---- managed extension updates, skills, setup ----

fn embedded() -> bool {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../extension/dist/manifest.json")
        .is_file()
}
fn ext_with(p: &Proxy, info: Value) -> Ws {
    try_connect_info(p.port, "ext", Some(EXT_ORIGIN), true, info).unwrap()
}
/// True if the next message the ext receives is a relayed request (i.e. no `update` was sent before it).
fn no_update_before_req(p: &Proxy, e: &mut Ws) -> bool {
    let mut c = cli(p);
    send(&mut c, json!({"t":"req","req":{}}));
    recv(e)["t"] == "req"
}

#[test]
fn managed_old_ext_gets_update_and_folder() {
    let p = start(&[]);
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":true}));
    let folder = p.dir.join("extension");
    if !embedded() {
        assert!(no_update_before_req(&p, &mut e));
        return;
    }
    let u = recv(&mut e);
    assert_eq!(u, json!({"t":"update","version":env!("CARGO_PKG_VERSION")}));
    assert!(folder.join("manifest.json").is_file());
    assert!(!folder.join("background.js.map").exists());
    let pairing: Value = serde_json::from_slice(&std::fs::read(folder.join("pairing.json")).unwrap()).unwrap();
    assert_eq!(pairing, json!({"secret":SECRET,"port":p.port}));
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(folder.join("pairing.json")).unwrap().permissions())
            & 0o777,
        0o600
    );
}

#[test]
fn managed_update_removes_stale_files_but_keeps_pairing() {
    if !embedded() {
        return;
    }
    let p = start(&[]);
    let folder = p.dir.join("extension");
    std::fs::create_dir_all(folder.join("old")).unwrap();
    std::fs::write(folder.join("old/stale.js"), "x").unwrap();
    std::fs::write(folder.join("pairing.json"), "{}").unwrap();
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":true}));
    assert_eq!(recv(&mut e)["t"], "update");
    assert!(!folder.join("old").exists());
    assert!(std::fs::read_to_string(folder.join("pairing.json"))
        .unwrap()
        .contains(SECRET));
}

#[test]
fn unmanaged_or_current_ext_gets_no_update() {
    let p = start(&[]);
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":false}));
    assert!(no_update_before_req(&p, &mut e));
    assert!(!p.dir.join("extension").exists());
    let mut e = ext_with(
        &p,
        json!({"browser":"T","extVersion":env!("CARGO_PKG_VERSION"),"managed":true}),
    );
    assert!(no_update_before_req(&p, &mut e));
    assert!(!p.dir.join("extension").exists());
}

fn run_bctl(dir: &std::path::Path, home: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bctl"))
        .args(args)
        .env("BCTL_CONFIG_DIR", dir)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("BCTL_PORT")
        .output()
        .unwrap()
}
fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bctl-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn skills_list_get_path_install() {
    let d = tmpdir("skills");
    let home = d.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let cfg = d.join("cfg");
    let out = |a: &[&str]| {
        let o = run_bctl(&cfg, &home, a);
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    };
    assert!(out(&["skills"]).starts_with("core\t"));
    assert_eq!(out(&["skills"]), out(&["skills", "list"]));
    let core = out(&["skills", "get", "core"]);
    assert!(core.starts_with("---\nname: core\n") && core.contains("bctl setup"));
    let r = out(&["skills", "get", "core", "--ref", "commands"]);
    assert!(r.contains("snapshot"));
    assert!(out(&["skills", "get", "core", "--full"]).contains(&r));
    assert!(!run_bctl(&cfg, &home, &["skills", "get", "nope"]).status.success());
    let path = out(&["skills", "path", "core"]);
    assert!(std::path::Path::new(path.trim()).join("SKILL.md").is_file());
    assert!(std::path::Path::new(path.trim())
        .join("references/commands.md")
        .is_file());

    out(&["skills", "install"]);
    let stub = std::fs::read_to_string(home.join(".agents/skills/bctl/SKILL.md")).unwrap();
    assert!(stub.contains("name: bctl") && stub.contains("bctl skills get core"));
    assert!(!home.join(".claude").exists());
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    out(&["skills", "install"]);
    assert!(home.join(".claude/skills/bctl/SKILL.md").is_file());
    out(&["skills", "install", "--dir", d.join("custom").to_str().unwrap()]);
    assert!(d.join("custom/bctl/SKILL.md").is_file());
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn setup_writes_folder_and_pairing() {
    let d = tmpdir("setup");
    let o = run_bctl(&d, &d, &["setup", "--no-open", "--no-wait"]);
    if !embedded() {
        assert!(!o.status.success());
        assert!(String::from_utf8_lossy(&o.stderr).contains("doesn't include the extension"));
        return;
    }
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let cfg: Value = serde_json::from_slice(&std::fs::read(d.join("config.json")).unwrap()).unwrap();
    let pairing: Value = serde_json::from_slice(&std::fs::read(d.join("extension/pairing.json")).unwrap()).unwrap();
    assert_eq!(cfg["secret"].as_str().unwrap().len(), 43);
    assert_eq!(pairing, cfg);
    assert!(d.join("extension/manifest.json").is_file());
    // Idempotent: keeps the secret.
    assert!(run_bctl(&d, &d, &["setup", "--no-open", "--no-wait"]).status.success());
    let cfg2: Value = serde_json::from_slice(&std::fs::read(d.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg, cfg2);
    // unpair removes pairing.json
    run_bctl(&d, &d, &["unpair"]);
    assert!(!d.join("extension/pairing.json").exists());
    std::fs::remove_dir_all(&d).ok();
}
