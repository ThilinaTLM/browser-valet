//! Integration tests: run `bvl proxy` as a child process (temp BVL_CONFIG_DIR, free port) and talk to it
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
    start_env(extra, &[])
}

/// Like `start`, with proxy environment overrides. Tests start with liveness probing off
/// (`BVL_EXT_PROBE_MS=0`: their fake extensions do not answer `ping`); the liveness tests turn it on.
#[allow(clippy::zombie_processes)]
fn start_env(extra: &[&str], env: &[(&str, &str)]) -> Proxy {
    // Picking a free port is racy across parallel tests: retry if our proxy died (e.g. port taken).
    for _ in 0..5 {
        if let Some(p) = try_start(extra, env) {
            return p;
        }
    }
    panic!("proxy did not start");
}

#[allow(clippy::zombie_processes)]
fn try_start(extra: &[&str], env: &[(&str, &str)]) -> Option<Proxy> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dir = std::env::temp_dir().join(format!("bvl-test-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        json!({"secret":SECRET,"port":port}).to_string(),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_bvl"))
        .arg("proxy")
        .args(extra)
        .env("BVL_CONFIG_DIR", &dir)
        .env("BVL_EXT_WAIT_MS", "400")
        .env("BVL_EXT_WAKE_MS", "1500")
        .env("BVL_EXT_PROBE_MS", "0")
        .envs(env.iter().copied())
        .env_remove("BVL_PORT")
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
    assert_eq!(r["res"]["code"], "not_connected");
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

/// Reads the next message with a short timeout; None if nothing arrives.
fn try_recv(ws: &mut Ws, ms: u64) -> Option<Value> {
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(ms))).unwrap();
    let r = loop {
        match ws.read() {
            Ok(Message::Text(t)) => break Some(serde_json::from_str(t.as_str()).unwrap()),
            Ok(_) => {}
            Err(_) => break None,
        }
    };
    ws.get_ref().set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    r
}

#[test]
fn failed_write_to_cli_cancels_once_and_clears_pending() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    assert_eq!(status(&p)["proxy"]["pending"], 1);
    // Kill the CLI socket without a close handshake, then make the proxy write to it.
    c.get_ref().shutdown(std::net::Shutdown::Both).ok();
    drop(c);
    for _ in 0..3 {
        send(&mut e, json!({"t":"event","id":id,"stderr":"x\n"}));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(recv(&mut e), json!({"t":"cancel","id":id}));
    assert!(try_recv(&mut e, 300).is_none(), "cancel sent twice");
    assert_eq!(status(&p)["proxy"]["pending"], 0);
}

#[test]
fn completed_request_is_not_cancelled() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    send(&mut e, json!({"t":"res","id":id,"res":{"exitCode":0}}));
    assert_eq!(recv(&mut c)["t"], "res");
    drop(c);
    assert!(try_recv(&mut e, 300).is_none());
    assert_eq!(status(&p)["proxy"]["pending"], 0);
}

#[test]
fn shutdown_fails_pending_requests_and_cancels_in_extension() {
    let mut p = start(&[]);
    let mut e = ext(&p);
    let mut c1 = cli(&p);
    let mut c2 = cli(&p);
    send(&mut c1, json!({"t":"req","req":{}}));
    send(&mut c2, json!({"t":"req","req":{}}));
    let mut ids = vec![recv(&mut e)["id"].clone(), recv(&mut e)["id"].clone()];
    let mut s = cli(&p);
    send(&mut s, json!({"t":"shutdown"}));
    assert_eq!(recv(&mut s)["t"], "ok");
    for c in [&mut c1, &mut c2] {
        let r = recv(c);
        assert_eq!(r["res"]["exitCode"], 1);
        assert!(r["res"]["stderr"].as_str().unwrap().contains("shutting down"));
    }
    let mut cancelled = vec![];
    for _ in 0..2 {
        let m = recv(&mut e);
        assert_eq!(m["t"], "cancel");
        cancelled.push(m["id"].clone());
    }
    ids.sort_by_key(|v| v.as_u64());
    cancelled.sort_by_key(|v| v.as_u64());
    assert_eq!(ids, cancelled);
    assert_eq!(recv(&mut e), json!({"t":"bye","reason":"stop"}));
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn newer_cli_does_not_restart_a_busy_proxy() {
    // Fake proxy of another version that reports one request in flight; the CLI must not send `shutdown`.
    let d = tmpdir("busy");
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    let t = std::thread::spawn(move || {
        let mut seen = vec![];
        l.set_nonblocking(false).unwrap();
        // Serve connections until the CLI exits (it connects, asks status, then gives up).
        let (s, _) = loop {
            let c = l.accept().unwrap();
            c.0.set_nonblocking(false).unwrap();
            if c.0.peek(&mut [0u8; 1]).is_ok_and(|n| n > 0) {
                break c;
            }
        };
        let mut ws = tungstenite::accept(s).unwrap();
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        let a = recv(&mut ws);
        let nc = a["nonce"].as_str().unwrap();
        send(
            &mut ws,
            json!({"t":"welcome","mac":mac(&format!("bctl1|server|cli|{nc}|aa")),"version":"0.0.0-old"}),
        );
        while let Ok(Message::Text(m)) = ws.read() {
            let v: Value = serde_json::from_str(m.as_str()).unwrap();
            seen.push(v["t"].as_str().unwrap().to_string());
            if v["t"] == "status" {
                send(
                    &mut ws,
                    json!({"t":"status","proxy":{"version":"0.0.0-old","pending":1},"ext":null}),
                );
            }
        }
        seen
    });
    let o = Command::new(env!("CARGO_BIN_EXE_bvl"))
        .arg("tabs")
        .env("BVL_CONFIG_DIR", &d)
        .env("BVL_PORT", port.to_string())
        .output()
        .unwrap();
    let seen = t.join().unwrap();
    assert_eq!(o.status.code(), Some(1));
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("busy with 1 request"), "{err}");
    assert_eq!(seen, ["status"]);
    std::fs::remove_dir_all(&d).ok();
}

// ---- liveness: a browser keeps the socket of a dead service worker open, so `ping` finds it out ----

/// Version the proxy expects of a probeable extension (extensions of another bundled version are not probed).
fn ext_version() -> String {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../extension/dist/manifest.json");
    std::fs::read(dist)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|m| m["version"].as_str().map(String::from))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}
fn live_ext(p: &Proxy) -> Ws {
    let info = json!({"browser":"Test Chrome 1","extVersion":ext_version()});
    try_connect_info(p.port, "ext", Some(EXT_ORIGIN), true, info).unwrap()
}
fn probing(wake_ms: &str) -> Proxy {
    start_env(&[], &[("BVL_EXT_PROBE_MS", "500"), ("BVL_EXT_WAKE_MS", wake_ms)])
}
/// Read the next `ping` and answer it.
fn pong(e: &mut Ws) {
    assert_eq!(recv(e), json!({"t":"ping"}));
    send(e, json!({"t":"pong"}));
}

#[test]
fn silent_extension_is_dropped_and_status_says_so() {
    let p = probing("4000");
    let mut e = live_ext(&p);
    let t = Instant::now();
    let s = status(&p);
    assert!(s["ext"].is_null());
    assert_eq!(s["extLost"]["reason"], "unresponsive");
    assert!(s["extLost"]["waitSecs"].as_u64().unwrap() <= 4);
    assert!(t.elapsed() < Duration::from_secs(4));
    assert_eq!(try_recv(&mut e, 500), Some(json!({"t":"ping"})));
    // A live but slow worker is told to reconnect rather than switch itself off.
    assert_eq!(try_recv(&mut e, 500), Some(json!({"t":"bye","reason":"restart"})));
}

#[test]
fn answering_extension_stays_connected() {
    let p = probing("4000");
    let mut e = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"status"}));
    pong(&mut e);
    let s = recv(&mut c);
    assert_eq!(s["ext"]["browser"], "Test Chrome 1");
    assert!(s["extLost"].is_null());
}

/// The `res` of a request is not proof of life: a wedged worker can still finish one (`tab close`) and then
/// hang on the next. A command right after a response is probed too.
#[test]
fn probes_right_after_a_response() {
    let p = probing("4000");
    let mut e = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    pong(&mut e);
    let r = recv(&mut e);
    send(&mut e, json!({"t":"res","id":r["id"],"res":{"exitCode":0,"stdout":""}}));
    assert_eq!(recv(&mut c)["t"], "res");
    // No pause: the extension is now "wedged" and does not answer.
    let s = status(&p);
    assert!(s["ext"].is_null(), "{s}");
    assert_eq!(recv(&mut e), json!({"t":"ping"}));
}

#[test]
fn status_does_not_drop_an_extension_with_a_request_in_flight() {
    let p = probing("4000");
    let mut e = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    pong(&mut e);
    let r = recv(&mut e);
    // Busy and silent: status is truthful (not connected) but the request is not failed.
    let t = Instant::now();
    let s = status(&p);
    assert!(s["ext"].is_null());
    assert_eq!(s["extLost"]["reason"], "unresponsive");
    assert!(t.elapsed() >= Duration::from_millis(1500), "waits longer when busy");
    assert_eq!(s["proxy"]["pending"], 1);
    send(
        &mut e,
        json!({"t":"res","id":r["id"],"res":{"exitCode":0,"stdout":"done\n"}}),
    );
    assert_eq!(recv(&mut c)["res"]["stdout"], "done\n");
}

#[test]
fn extension_silent_for_too_long_is_dropped_but_pings_keep_it() {
    let p = start_env(&[], &[("BVL_EXT_SILENT_MS", "700")]);
    let mut kept = live_ext(&p);
    for _ in 0..8 {
        send(&mut kept, json!({"t":"ping"}));
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(status(&p)["ext"].is_object());
    // Now it goes quiet.
    let end = Instant::now() + Duration::from_secs(4);
    let s = loop {
        let s = status(&p);
        if s["ext"].is_null() || Instant::now() > end {
            break s;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    assert!(s["ext"].is_null(), "{s}");
    assert_eq!(s["extLost"]["reason"], "unresponsive");
}

#[test]
fn lost_is_cleared_by_a_reconnect_and_expires() {
    let p = probing("1500");
    let _dead = live_ext(&p);
    assert!(status(&p)["extLost"].is_object());
    let mut back = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"status"}));
    pong(&mut back);
    let s = recv(&mut c);
    assert!(s["ext"].is_object() && s["extLost"].is_null(), "{s}");
    // A new loss, and nobody comes back: after `wake_wait` it is forgotten, and a request gets the
    // ordinary "switch it on" answer.
    drop(back);
    std::thread::sleep(Duration::from_millis(100));
    assert!(status(&p)["extLost"].is_object());
    std::thread::sleep(Duration::from_millis(1700));
    let s = status(&p);
    assert!(s["extLost"].is_null(), "{s}");
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let r = recv(&mut c);
    assert!(r["res"]["stderr"].as_str().unwrap().contains("switch it on"));
}

/// A connection that replaces the one being probed must not be dropped by the old probe.
#[test]
fn replacement_during_a_probe_is_not_dropped() {
    let p = start_env(&[], &[("BVL_EXT_PROBE_MS", "1500")]);
    let _old = live_ext(&p);
    let port = p.port;
    let probe = std::thread::spawn(move || {
        let mut c = try_connect(port, "cli", None, true).unwrap();
        send(&mut c, json!({"t":"status"}));
        recv(&mut c)
    });
    std::thread::sleep(Duration::from_millis(300));
    let mut new = live_ext(&p);
    let s = probe.join().unwrap();
    assert!(s["ext"].is_object(), "{s}");
    assert_eq!(
        try_recv(&mut new, 300),
        None,
        "the new connection was probed or dropped"
    );
}

#[test]
fn request_waits_for_a_dead_extension_to_come_back() {
    let p = probing("8000");
    let _dead = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{"argv":["x"]}}));
    let note = recv(&mut c);
    assert_eq!(note["t"], "event");
    assert!(note["stderr"].as_str().unwrap().contains("waiting for it to restart"));
    // The worker "restarts" after the ordinary wait for an extension has passed.
    std::thread::sleep(Duration::from_millis(1200));
    let mut e = live_ext(&p);
    let r = recv(&mut e);
    assert_eq!(r["t"], "req");
    send(
        &mut e,
        json!({"t":"res","id":r["id"],"res":{"exitCode":0,"stdout":"ok\n"}}),
    );
    assert_eq!(recv(&mut c)["res"]["stdout"], "ok\n");
}

#[test]
fn request_fails_when_a_dead_extension_does_not_come_back() {
    let p = probing("1500");
    let mut e = live_ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    // The ping marks the start of the probe; the drop follows 500 ms later, and the wait 1500 ms after that.
    assert_eq!(recv(&mut e), json!({"t":"ping"}));
    let ping_at = Instant::now();
    assert_eq!(recv(&mut c)["t"], "event");
    let r = recv(&mut c);
    assert!(
        ping_at.elapsed() >= Duration::from_millis(1900),
        "{:?}",
        ping_at.elapsed()
    );
    assert_eq!(r["res"]["code"], "not_connected");
    assert!(r["res"]["stderr"].as_str().unwrap().contains("stopped responding"));
}

/// An extension of another version than the bundled one may predate `ping`: it is not probed or dropped.
#[test]
fn extension_of_another_version_is_not_probed() {
    if !embedded() {
        return;
    }
    let p = probing("4000");
    let mut e = ext_with(&p, json!({"browser":"Test Chrome 1","extVersion":"0.0.1"}));
    let s = status(&p);
    assert!(s["ext"].is_object(), "{s}");
    assert_eq!(try_recv(&mut e, 300), None);
}

#[test]
fn vanished_extension_is_waited_for_but_a_closed_one_is_not() {
    let p = start(&[]);
    // Closed with a close frame (switched off): the usual "not connected" after the short wait.
    let mut e = ext(&p);
    e.close(None).ok();
    e.flush().ok();
    std::thread::sleep(Duration::from_millis(200));
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let r = recv(&mut c);
    assert!(r["res"]["stderr"].as_str().unwrap().contains("switch it on"));
    // Torn down by the browser with 1001 "going away" (what a terminated worker sends): wait for a restart.
    let mut e = ext(&p);
    e.close(Some(tungstenite::protocol::CloseFrame {
        code: tungstenite::protocol::frame::coding::CloseCode::Away,
        reason: "".into(),
    }))
    .ok();
    e.flush().ok();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(status(&p)["extLost"]["reason"], "vanished");
    // Gone without a close frame: the same.
    let e = ext(&p);
    e.get_ref().shutdown(std::net::Shutdown::Both).ok();
    drop(e);
    std::thread::sleep(Duration::from_millis(200));
    let s = status(&p);
    assert_eq!(s["extLost"]["reason"], "vanished");
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    assert_eq!(recv(&mut c)["t"], "event");
    assert!(recv(&mut c)["res"]["stderr"]
        .as_str()
        .unwrap()
        .contains("stopped responding"));
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
    assert!(r["res"]["stderr"].as_str().unwrap().contains("switch it on"));
    assert_eq!(r["res"]["code"], "not_connected");
}

#[test]
fn idle_timeout_exits() {
    let mut p = start(&["--idle-timeout", "1"]);
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn idle_exit_says_bye_to_the_extension() {
    let mut p = start(&["--idle-timeout", "1"]);
    let mut e = ext(&p);
    assert_eq!(recv(&mut e), json!({"t":"bye","reason":"idle"}));
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn shutdown_reason_reaches_the_extension() {
    for (sent, said) in [
        (json!("restart"), "restart"),
        (json!("stop"), "stop"),
        (Value::Null, "stop"),
        (json!("bogus"), "stop"),
    ] {
        let mut p = start(&[]);
        let mut e = ext(&p);
        let mut c = cli(&p);
        let mut msg = json!({"t":"shutdown"});
        if !sent.is_null() {
            msg["reason"] = sent;
        }
        send(&mut c, msg);
        assert_eq!(recv(&mut c)["t"], "ok");
        assert_eq!(recv(&mut e), json!({"t":"bye","reason":said}));
        assert!(wait_exit(&mut p, 5));
    }
}

#[test]
fn shutdown_exits() {
    let mut p = start(&[]);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"shutdown"}));
    assert_eq!(recv(&mut c)["t"], "ok");
    assert!(wait_exit(&mut p, 5));
}

fn bvl(p: &Proxy, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bvl"))
        .args(args)
        .env("BVL_CONFIG_DIR", &p.dir)
        .env("BVL_PORT", p.port.to_string())
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
    let o = bvl(&p, &["echo", "hi"]);
    let _e = t.join().unwrap();
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(o.stdout, b"out");
    assert_eq!(String::from_utf8_lossy(&o.stderr), "progress\nerr");
    assert_eq!(std::fs::read(&out).unwrap(), b"hello");
    let s = bvl(&p, &["status"]);
    let s = String::from_utf8_lossy(&s.stdout).to_string();
    assert!(s.contains("extension: Test Chrome 1 (extension v9.9.9)"), "{s}");
}

#[test]
fn cli_binary_unpaired_and_bad_server_mac() {
    let p = start(&[]);
    std::fs::remove_file(p.dir.join("config.json")).unwrap();
    let o = bvl(&p, &["tabs"]);
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
    let o = Command::new(env!("CARGO_BIN_EXE_bvl"))
        .arg("tabs")
        .env("BVL_CONFIG_DIR", &p.dir)
        .env("BVL_PORT", port.to_string())
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

fn run_bvl(dir: &std::path::Path, home: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bvl"))
        .args(args)
        .env("BVL_CONFIG_DIR", dir)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("BVL_PORT")
        .output()
        .unwrap()
}
fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bvl-{tag}-{}", std::process::id()));
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
        let o = run_bvl(&cfg, &home, a);
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    };
    assert!(out(&["skills"]).starts_with("core\t"));
    assert_eq!(out(&["skills"]), out(&["skills", "list"]));
    let core = out(&["skills", "get", "core"]);
    assert!(core.starts_with("---\nname: core\n") && core.contains("bvl setup"));
    let r = out(&["skills", "get", "core", "--ref", "commands"]);
    assert!(r.contains("snapshot"));
    assert!(out(&["skills", "get", "core", "--full"]).contains(&r));
    let dog = out(&["skills", "get", "dogfood"]);
    assert!(dog.starts_with("---\nname: dogfood\n"));
    assert!(out(&["skills", "list"]).lines().any(|l| l.starts_with("dogfood\t")));
    assert!(std::path::Path::new(out(&["skills", "path", "dogfood"]).trim())
        .join("SKILL.md")
        .is_file());
    assert!(out(&["skills", "get", "dogfood", "--ref", "issue-taxonomy"]).contains("Severity"));
    assert!(out(&["skills", "get", "dogfood", "--ref", "report-template"]).contains("ISSUE-001"));
    let dc = out(&["skills", "get", "derive-client"]);
    assert!(dc.starts_with("---\nname: derive-client\n") && dc.contains("redacted"));
    assert!(out(&["skills", "list"])
        .lines()
        .any(|l| l.starts_with("derive-client\t")));
    assert!(std::path::Path::new(out(&["skills", "path", "derive-client"]).trim())
        .join("SKILL.md")
        .is_file());
    assert!(!run_bvl(&cfg, &home, &["skills", "get", "nope"]).status.success());
    let path = out(&["skills", "path", "core"]);
    assert!(std::path::Path::new(path.trim()).join("SKILL.md").is_file());
    assert!(std::path::Path::new(path.trim())
        .join("references/commands.md")
        .is_file());

    // Default locations: on Windows `dirs::home_dir()` asks the OS for the profile folder and
    // ignores USERPROFILE, so the home can't be redirected and this would write to the real one.
    if !cfg!(windows) {
        out(&["skills", "install"]);
        let stub = std::fs::read_to_string(home.join(".agents/skills/bvl/SKILL.md")).unwrap();
        assert!(stub.contains("name: bvl") && stub.contains("bvl skills get core"));
        assert!(!home.join(".claude").exists());
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        out(&["skills", "install"]);
        assert!(home.join(".claude/skills/bvl/SKILL.md").is_file());
    }
    out(&["skills", "install", "--dir", d.join("custom").to_str().unwrap()]);
    let stub = std::fs::read_to_string(d.join("custom/bvl/SKILL.md")).unwrap();
    assert!(stub.contains("name: bvl") && stub.contains("bvl skills get core"));
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn setup_writes_folder_and_pairing() {
    let d = tmpdir("setup");
    let o = run_bvl(&d, &d, &["setup", "--no-wait"]);
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
    assert!(run_bvl(&d, &d, &["setup", "--no-wait"]).status.success());
    let cfg2: Value = serde_json::from_slice(&std::fs::read(d.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg, cfg2);
    // unpair removes pairing.json
    run_bvl(&d, &d, &["unpair"]);
    assert!(!d.join("extension/pairing.json").exists());
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn config_and_data_dirs_are_separate() {
    let d = tmpdir("dirs");
    let (cfg, data) = (d.join("cfg"), d.join("data"));
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_bvl"))
            .args(args)
            .env("BVL_CONFIG_DIR", &cfg)
            .env("BVL_DATA_DIR", &data)
            .env("HOME", &d)
            .env("USERPROFILE", &d)
            .env_remove("BVL_PORT")
            .output()
            .unwrap()
    };
    let o = run(&["skills", "path", "core"]);
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    assert!(data.join("skills/core/SKILL.md").is_file());
    assert!(!cfg.join("skills").exists());
    if embedded() {
        let o = run(&["setup", "--no-wait"]);
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert!(cfg.join("config.json").is_file());
        assert!(!data.join("config.json").exists());
        assert!(data.join("extension/manifest.json").is_file());
        assert!(data.join("extension/pairing.json").is_file());
        assert!(!cfg.join("extension").exists());
        assert!(String::from_utf8_lossy(&o.stdout).contains(&data.join("extension").display().to_string()));
        run(&["unpair"]);
        assert!(!data.join("extension/pairing.json").exists());
        assert!(!cfg.join("config.json").exists());
    }
    std::fs::remove_dir_all(&d).ok();
}

// ---- doctor ----

fn doctor(dir: &std::path::Path, port: u16, args: &[&str]) -> (Value, i32) {
    let o = Command::new(env!("CARGO_BIN_EXE_bvl"))
        .arg("doctor")
        .args(args)
        .arg("--json")
        .env("BVL_CONFIG_DIR", dir)
        .env("BVL_PORT", port.to_string())
        .output()
        .unwrap();
    let v: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}: {}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    });
    (v, o.status.code().unwrap())
}
fn check<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
}
fn chmod(path: &std::path::Path, _mode: u32) {
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(_mode)).unwrap();
    let _ = path;
}
/// Fake extension that answers every request with exit code 0 until its socket closes.
fn answering_ext(p: &Proxy, info: Value) -> std::thread::JoinHandle<()> {
    let mut e = ext_with(p, info);
    std::thread::spawn(move || {
        while let Ok(Message::Text(t)) = e.read() {
            let r: Value = serde_json::from_str(t.as_str()).unwrap();
            if r["t"] == "req" {
                assert_eq!(r["req"]["argv"], json!(["help"]));
                send(
                    &mut e,
                    json!({"t":"res","id":r["id"],"res":{"exitCode":0,"stdout":"help\n"}}),
                );
            }
        }
    })
}

#[test]
fn doctor_all_green_with_extension() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let info = json!({"browser":"Google Chrome 150","extVersion":env!("CARGO_PKG_VERSION"),"managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &[]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["ok"], true);
    for n in ["config", "managed folder", "proxy", "extension", "round trip"] {
        assert_eq!(check(&v, n)["status"], "pass", "{n}: {v}");
    }
    assert!(check(&v, "round trip")["message"].as_str().unwrap().contains(" ms"));
    // Text output uses marks and ends with a summary.
    let o = bvl(&p, &["doctor", "--quick"]);
    let s = String::from_utf8_lossy(&o.stdout);
    assert!(s.contains("✓ proxy:") && s.ends_with("All good.\n"), "{s}");
}

#[test]
fn doctor_reports_missing_extension_and_old_browser() {
    let p = start(&[]);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 1);
    assert_eq!(check(&v, "proxy")["status"], "pass");
    assert_eq!(check(&v, "extension")["status"], "fail");
    assert!(check(&v, "extension")["message"]
        .as_str()
        .unwrap()
        .contains("not connected"));
    assert_eq!(check(&v, "round trip")["status"], "skip");

    let info = json!({"browser":"Google Chrome 120","extVersion":env!("CARGO_PKG_VERSION"),"managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 1);
    assert!(
        check(&v, "extension")["message"].as_str().unwrap().contains("127"),
        "{v}"
    );
}

#[test]
fn doctor_warns_on_extension_version_mismatch() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let info = json!({"browser":"Google Chrome 150","extVersion":"0.0.1","managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 0);
    assert_eq!(check(&v, "extension")["status"], "warn");
    assert!(check(&v, "extension")["fix"].is_string());
}

#[test]
fn doctor_without_config_fails_and_skips_the_rest() {
    let d = tmpdir("doctor-nocfg");
    let (v, code) = doctor(&d, 1, &[]);
    assert_eq!(code, 1);
    assert_eq!(check(&v, "config")["status"], "fail");
    assert_eq!(check(&v, "proxy")["status"], "skip");
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn doctor_quick_does_not_start_a_proxy() {
    let d = tmpdir("doctor-quick");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    chmod(&d.join("config.json"), 0o600);
    let (v, code) = doctor(&d, port, &["--quick"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(check(&v, "proxy")["status"], "warn");
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    std::fs::remove_dir_all(&d).ok();
}

#[cfg(unix)]
#[test]
fn doctor_config_permissions_and_fix() {
    let p = start(&[]);
    let cfg = p.dir.join("config.json");
    chmod(&cfg, 0o644);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!((code, check(&v, "config")["status"].as_str()), (1, Some("fail")));
    let (v, _) = doctor(&p.dir, p.port, &["--quick", "--fix"]);
    assert_eq!(check(&v, "config")["status"], "fixed");
    let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&cfg).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn doctor_managed_folder_mismatch_and_fix() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let folder = p.dir.join("extension");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("manifest.json"), json!({"version":"0.0.1"}).to_string()).unwrap();
    std::fs::write(
        folder.join("pairing.json"),
        json!({"secret":"other","port":p.port}).to_string(),
    )
    .unwrap();
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(
        (code, check(&v, "managed folder")["status"].as_str()),
        (1, Some("fail"))
    );
    assert!(check(&v, "managed folder")["message"]
        .as_str()
        .unwrap()
        .contains("pairing.json"));
    let (v, _) = doctor(&p.dir, p.port, &["--quick", "--fix"]);
    if embedded() {
        assert_eq!(check(&v, "managed folder")["status"], "fixed");
        let pairing: Value = serde_json::from_slice(&std::fs::read(folder.join("pairing.json")).unwrap()).unwrap();
        assert_eq!(pairing, json!({"secret":SECRET,"port":p.port}));
        assert_eq!(doctor(&p.dir, p.port, &["--quick"]).0["checks"][1]["status"], "pass");
    } else {
        assert_eq!(check(&v, "managed folder")["status"], "fail");
    }
}

#[test]
fn doctor_detects_a_squatter_on_the_port() {
    let d = tmpdir("doctor-squat");
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    chmod(&d.join("config.json"), 0o600);
    let t = std::thread::spawn(move || {
        let mut ws = loop {
            if let Ok(ws) = tungstenite::accept(l.accept().unwrap().0) {
                break ws;
            }
        };
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        recv(&mut ws);
        send(&mut ws, json!({"t":"welcome","mac":"00","version":"x"}));
    });
    let (v, code) = doctor(&d, port, &["--quick"]);
    t.join().unwrap();
    assert_eq!(code, 1);
    assert_eq!(check(&v, "proxy")["status"], "fail");
    assert!(check(&v, "proxy")["message"]
        .as_str()
        .unwrap()
        .contains("server authentication failed"));
    std::fs::remove_dir_all(&d).ok();
}

// ---- help ----

fn text(o: &Output) -> String {
    String::from_utf8_lossy(&o.stdout).to_string()
}

#[test]
fn help_works_unpaired_and_never_runs_local_commands() {
    let d = tmpdir("help-unpaired");
    for args in [&[][..], &["--help"], &["-h"], &["help"]] {
        let o = run_bvl(&d, &d, args);
        let s = text(&o);
        assert_eq!(o.status.code(), Some(0), "{args:?}: {s}");
        assert!(s.contains("Start here (for AI agents): `bvl skills get core`"), "{s}");
        assert!(s.contains("  doctor    "), "{s}");
        assert!(
            s.contains("not paired yet") && s.contains("bvl skills get core --ref commands"),
            "{s}"
        );
    }
    let o = run_bvl(&d, &d, &["help", "setup"]);
    assert!(text(&o).starts_with("Usage: bvl setup [--browser"), "{}", text(&o));
    assert!(!d.join("extension").exists(), "help must not run setup");
    let o = run_bvl(&d, &d, &["click", "--help"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("--ref commands"));
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn local_command_help_does_not_unpair_or_stop() {
    let mut p = start(&[]);
    for cmd in ["unpair", "stop"] {
        for flag in ["--help", "-h"] {
            let o = bvl(&p, &[cmd, flag]);
            assert_eq!(o.status.code(), Some(0));
            assert!(text(&o).starts_with(&format!("Usage: bvl {cmd}")), "{}", text(&o));
        }
    }
    assert!(p.dir.join("config.json").is_file());
    assert!(!wait_exit(&mut p, 1), "proxy must keep running");
}

#[test]
fn help_appends_the_extension_command_list() {
    let p = start(&[]);
    let _t = answering_ext(
        &p,
        json!({"browser":"Test Chrome 1","extVersion":env!("CARGO_PKG_VERSION")}),
    );
    let o = bvl(&p, &["--help"]);
    let s = text(&o);
    assert_eq!(o.status.code(), Some(0), "{s}");
    assert!(
        s.contains("Start here (for AI agents)") && s.ends_with("\nhelp\n"),
        "{s}"
    );
}

#[test]
fn help_with_the_extension_off_says_so_quickly() {
    let p = start(&[]);
    let t = Instant::now();
    let o = bvl(&p, &["help"]);
    let s = text(&o);
    assert_eq!(o.status.code(), Some(0), "{s}");
    assert!(s.contains("Start here") && s.contains("switch it on"), "{s}");
    assert!(t.elapsed() < Duration::from_secs(6), "{:?}", t.elapsed());
}

#[test]
fn cli_status_waits_briefly_for_the_extension() {
    let p = start(&[]);
    let port = p.port;
    // The extension connects a moment after `bvl status` asked (as after a fresh proxy start).
    let t = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(800));
        try_connect(port, "ext", Some(EXT_ORIGIN), true).unwrap()
    });
    let s = bvl(&p, &["status"]);
    let _e = t.join().unwrap();
    let s = String::from_utf8_lossy(&s.stdout).to_string();
    assert!(s.contains("extension: Test Chrome 1"), "{s}");
}
