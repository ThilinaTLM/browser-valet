//! Stateless relay: authenticates `cli` and `ext` peers and routes requests between them.
use crate::embed::EMBEDDED_EXT_VERSION;
use crate::{log, mac, nonce, verify, VERSION};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::{handshake::server::*, http, Message};
use tokio_tungstenite::WebSocketStream;

/// The only extension origin allowed to connect as role `ext` (derived from the key in manifest.json).
const EXT_ORIGIN: &str = "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm";

type Ws = WebSocketStream<TcpStream>;

/// A live extension sends something at least every 20 s (its `ping`). Silent for longer than this: dead.
const EXT_SILENT: Duration = Duration::from_secs(50);
/// Before `status` or a `req` trusts the extension connection, it must have been heard from this recently
/// or answer a `ping` within `PROBE_WAIT`. A browser keeps a dead service worker's socket open.
const FRESH: Duration = Duration::from_millis(500);
const PROBE_WAIT: Duration = Duration::from_millis(2500);
/// A dead worker restarts on the next browser event or at the latest on its 30 s alarm.
const WAKE_WAIT_MS: u64 = 35_000;

/// Shown to the agent when no extension is connected. The usual cause is the switch being off.
pub const NOT_CONNECTED: &str =
    "browser extension is not connected. It is switched off by default, and switches itself off \
when bvl stops or has been idle, and when the browser restarts. Ask the user to click the Browser Valet icon in their \
browser and switch it on, then retry. If it was never installed, the user runs `bvl setup` first.";

/// Shown when the extension stopped answering and did not come back in time.
pub const WORKER_DEAD: &str = "browser extension stopped responding and did not restart in time. Its background worker was \
terminated by the browser (this happens when a controlled tab is closed). Opening the Browser Valet popup or any browser \
activity wakes it; then retry.";

/// An in-flight request: which ext connection owns it, how to reach that ext, how to reach the CLI.
struct Pending {
    owner: u64,
    ext: mpsc::UnboundedSender<String>,
    out: mpsc::UnboundedSender<Value>,
}
struct Ext {
    conn: u64,
    tx: mpsc::UnboundedSender<String>,
    info: Value,
    /// When the last frame (any) arrived from the extension.
    rx: Instant,
}
struct State {
    ext: Option<Ext>,
    pending: HashMap<u64, Pending>,
    /// `request` calls still running (they must flush their final message before the proxy exits).
    active: usize,
    /// Extension connection loops still running (they must flush `bye` before the proxy exits).
    exts: usize,
    next: u64,
    last: Instant,
    /// When the proxy last dropped an extension that stopped answering (cleared when one connects).
    lost: Option<Instant>,
}
struct Shared {
    secret: String,
    port: u16,
    idle: u64,
    ext_wait: Duration,
    /// How long a request waits for an extension whose worker died to restart.
    wake_wait: Duration,
    st: Mutex<State>,
    stop: Notify,
}

pub fn run(secret: String, port: u16, idle: u64) -> Result<()> {
    let ms = |var: &str, default: u64| {
        Duration::from_millis(std::env::var(var).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
    };
    let sh = Arc::new(Shared {
        secret,
        port,
        idle,
        ext_wait: ms("BVL_EXT_WAIT_MS", 10_000),
        wake_wait: ms("BVL_EXT_WAKE_MS", WAKE_WAIT_MS),
        st: Mutex::new(State {
            ext: None,
            pending: HashMap::new(),
            active: 0,
            exts: 0,
            next: 1,
            last: Instant::now(),
            lost: None,
        }),
        stop: Notify::new(),
    });
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(serve_all(sh))
}

async fn serve_all(sh: Arc<Shared>) -> Result<()> {
    let l = TcpListener::bind(("127.0.0.1", sh.port))
        .await
        .with_context(|| format!("bind 127.0.0.1:{}", sh.port))?;
    log(&format!(
        "proxy {VERSION} listening on 127.0.0.1:{} (idle timeout {}s)",
        sh.port, sh.idle
    ));
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            r = l.accept() => if let Ok((s, addr)) = r {
                let sh = sh.clone();
                tokio::spawn(async move {
                    if let Err(e) = conn(sh, s).await { log(&format!("connection {addr}: {e}")); }
                });
            },
            _ = sh.stop.notified() => {
                log("shutdown requested");
                flush(&sh).await;
                return Ok(());
            }
            _ = tick.tick() => {
                drop_if_silent(&sh, EXT_SILENT);
                if sh.idle == 0 { continue; }
                let idle = {
                    let mut st = sh.st.lock().unwrap();
                    let idle = st.pending.is_empty() && st.last.elapsed() >= Duration::from_secs(sh.idle);
                    if idle {
                        bye(&mut st, "idle");
                    }
                    idle
                };
                if idle {
                    log("idle timeout, exiting");
                    flush(&sh).await;
                    return Ok(());
                }
            }
        }
    }
}

/// Drop the extension connection if nothing arrived from it for `after`. Its pending requests fail
/// (the connection loop ends) and `lost` records it. The `bye restart` is for a worker that is alive but
/// slow: it reconnects instead of switching itself off; a dead one never reads it.
fn drop_if_silent(sh: &Shared, after: Duration) -> bool {
    let mut st = sh.st.lock().unwrap();
    if st.ext.as_ref().is_some_and(|e| e.rx.elapsed() >= after) {
        bye(&mut st, "restart");
        st.lost = Some(Instant::now());
        log("extension stopped answering, dropped its connection");
        return true;
    }
    false
}

/// Make sure the extension connection is live: heard from just now, or answering a `ping`.
/// Returns false (and drops the connection) when it is not. No-op without a connection.
async fn probe_ext(sh: &Shared) -> bool {
    let sent = Instant::now();
    {
        let st = sh.st.lock().unwrap();
        let Some(e) = st.ext.as_ref() else { return true };
        // A worker busy with a request may be slow to answer; the silence limit covers a dead one.
        if e.rx.elapsed() < FRESH || st.pending.values().any(|p| p.owner == e.conn) {
            return true;
        }
        e.tx.send(json!({"t":"ping"}).to_string()).ok();
    }
    while sent.elapsed() < PROBE_WAIT {
        sleep(Duration::from_millis(25)).await;
        let st = sh.st.lock().unwrap();
        match st.ext.as_ref() {
            None => return true,
            Some(e) if e.rx > sent => return true,
            _ => {}
        }
    }
    // Only drop what we probed: a newer connection may have replaced it meanwhile.
    !drop_if_silent(sh, sent.elapsed().min(PROBE_WAIT))
}

/// Tell the extension why the proxy is going away and close its connection. `restart` keeps the
/// extension switched on; anything else (or no `bye` at all) switches it off.
fn bye(st: &mut State, reason: &str) {
    // Taking the entry drops its sender after the queued `bye`, which ends the connection loop.
    if let Some(e) = st.ext.take() {
        e.tx.send(json!({"t":"bye","reason":reason}).to_string()).ok();
    }
}

/// Before exiting: let in-flight requests write their failure `res` to their CLIs, and the
/// extension connection write its `bye` (at most 1 s).
async fn flush(sh: &Shared) {
    for _ in 0..20 {
        {
            let st = sh.st.lock().unwrap();
            if st.active == 0 && st.exts == 0 {
                break;
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn send(ws: &mut Ws, v: Value) -> Result<()> {
    Ok(ws.send(Message::text(v.to_string())).await?)
}

/// Next JSON text frame; None on close/error. Cancel-safe (keeps no state between polls).
async fn next_json(ws: &mut Ws) -> Option<Value> {
    next_json_noting(ws, &mut false).await
}

/// Like `next_json`; sets `clean` when the peer ended the connection with a close frame (as opposed to
/// vanishing, which is what a terminated worker does).
async fn next_json_noting(ws: &mut Ws, clean: &mut bool) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str(t.as_str()) {
                    return Some(v);
                }
            }
            Ok(Message::Close(_)) => {
                *clean = true;
                return None;
            }
            Err(_) => return None,
            _ => {}
        }
    }
}

fn err_res(msg: &str) -> Value {
    json!({"t":"res","res":{"exitCode":1,"stdout":"","stderr":format!("{msg}\n"),"code":"not_connected"}})
}

async fn conn(sh: Arc<Shared>, tcp: TcpStream) -> Result<()> {
    // The CLI checks whether the proxy is up with a bare TCP connect; ignore those quietly.
    if matches!(tcp.peek(&mut [0u8; 1]).await, Ok(0) | Err(_)) {
        return Ok(());
    }
    let origin = Arc::new(Mutex::new(None::<String>));
    let o2 = origin.clone();
    #[allow(clippy::result_large_err)]
    let cb = move |req: &Request, resp: Response| {
        let o = req
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .map(String::from);
        if o.as_ref().is_some_and(|o| o != EXT_ORIGIN) {
            let r = http::Response::builder()
                .status(403)
                .body(Some("forbidden origin".to_string()))
                .unwrap();
            return Err(r);
        }
        *o2.lock().unwrap() = o;
        Ok(resp)
    };
    let mut ws = tokio_tungstenite::accept_hdr_async(tcp, cb)
        .await
        .context("upgrade rejected")?;
    let is_ext_origin = origin.lock().unwrap().is_some();

    let np = nonce();
    send(&mut ws, json!({"t":"challenge","nonce":np})).await?;
    let auth = timeout(Duration::from_secs(10), next_json(&mut ws))
        .await?
        .context("closed before auth")?;
    let s = |k: &str| auth[k].as_str().unwrap_or("").to_string();
    let (role, nc) = (s("role"), s("nonce"));
    let fail = |m: &'static str| json!({"t":"error","error":m});
    if auth["t"] != "auth" || !["cli", "ext"].contains(&role.as_str()) || (role == "ext") != is_ext_origin {
        send(&mut ws, fail("authentication failed: role not allowed for this origin"))
            .await
            .ok();
        anyhow::bail!("rejected: bad auth message or role/origin mismatch (role '{role}')");
    }
    if !verify(&sh.secret, &format!("bctl1|client|{role}|{np}|{nc}"), &s("mac")) {
        send(&mut ws, fail("authentication failed (re-pair with `bvl pair`)"))
            .await
            .ok();
        anyhow::bail!("authentication failed (role {role})");
    }
    let m = mac(&sh.secret, &format!("bctl1|server|{role}|{nc}|{np}"));
    send(&mut ws, json!({"t":"welcome","mac":m,"version":VERSION})).await?;
    log(&format!("{role} connected (version {})", s("version")));
    if role == "ext" {
        let info = auth["info"].clone();
        let update = pending_update(&sh, &info);
        ext_conn(&sh, ws, info, update).await;
        Ok(())
    } else {
        cli_conn(&sh, ws).await
    }
}

/// A managed extension running a different version than the embedded one gets the managed folder rewritten
/// and an `update` message. Returns the version to announce, if any. Never fails the connection.
fn pending_update(sh: &Shared, info: &Value) -> Option<&'static str> {
    let emb = EMBEDDED_EXT_VERSION?;
    if info["managed"] != true || info["extVersion"].as_str() == Some(emb) {
        return None;
    }
    match crate::embed::write_managed(&sh.secret, sh.port) {
        Ok(p) => {
            log(&format!(
                "extension {} -> {emb}: rewrote {}",
                info["extVersion"].as_str().unwrap_or("?"),
                p.display()
            ));
            Some(emb)
        }
        Err(e) => {
            log(&format!("cannot update managed extension folder: {e:#}"));
            None
        }
    }
}

async fn ext_conn(sh: &Shared, mut ws: Ws, info: Value, update: Option<&str>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = {
        let mut st = sh.st.lock().unwrap();
        st.next += 1;
        let id = st.next;
        // Replacing drops the old sender, which ends the old connection's loop.
        if let Some(v) = update {
            tx.send(json!({"t":"update","version":v}).to_string()).ok();
        }
        st.ext = Some(Ext {
            conn: id,
            tx,
            info,
            rx: Instant::now(),
        });
        st.lost = None;
        st.exts += 1;
        id
    };
    let mut clean = false;
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(s) => if ws.send(Message::text(s)).await.is_err() { break },
                None => break,
            },
            m = next_json_noting(&mut ws, &mut clean) => match m {
                None => break,
                Some(v) => {
                    if let Some(e) = sh.st.lock().unwrap().ext.as_mut().filter(|e| e.conn == id) {
                        e.rx = Instant::now();
                    }
                    route(sh, &v)
                }
            },
        }
    }
    // A dead peer may never complete the close handshake.
    timeout(Duration::from_secs(1), ws.close(None)).await.ok();
    let mut st = sh.st.lock().unwrap();
    st.exts -= 1;
    if st.ext.as_ref().is_some_and(|e| e.conn == id) {
        st.ext = None;
        // No close frame: the worker was terminated, not switched off. A request should wait for its restart.
        if !clean {
            st.lost = Some(Instant::now());
        }
    }
    let dead: Vec<u64> = st
        .pending
        .iter()
        .filter(|(_, p)| p.owner == id)
        .map(|(k, _)| *k)
        .collect();
    for k in dead {
        let p = st.pending.remove(&k).unwrap();
        p.out.send(err_res("browser extension disconnected")).ok();
    }
    log("ext disconnected");
}

/// Forward ext `event`/`res` messages to the waiting CLI, minus the id.
fn route(sh: &Shared, v: &Value) {
    let (Some(t), Some(id)) = (v["t"].as_str(), v["id"].as_u64()) else {
        return;
    };
    let mut st = sh.st.lock().unwrap();
    match t {
        "event" => {
            if let Some(p) = st.pending.get(&id) {
                p.out.send(json!({"t":"event","stderr":v["stderr"]})).ok();
            }
        }
        "res" => {
            if let Some(p) = st.pending.remove(&id) {
                p.out.send(json!({"t":"res","res":v["res"]})).ok();
            }
        }
        _ => {}
    }
}

async fn cli_conn(sh: &Shared, mut ws: Ws) -> Result<()> {
    let msg = timeout(Duration::from_secs(10), next_json(&mut ws))
        .await?
        .context("closed before request")?;
    match msg["t"].as_str() {
        Some("status") => {
            probe_ext(sh).await;
            let ext = sh
                .st
                .lock()
                .unwrap()
                .ext
                .as_ref()
                .map_or(Value::Null, |e| e.info.clone());
            let pending = sh.st.lock().unwrap().pending.len();
            let proxy = json!({"version":VERSION,"pid":std::process::id(),"port":sh.port,"idleTimeoutSecs":sh.idle,"pending":pending});
            let v = json!({"t":"status","proxy":proxy,"ext":ext});
            send(&mut ws, v).await
        }
        Some("shutdown") => {
            let reason = match msg["reason"].as_str() {
                Some("restart") => "restart",
                _ => "stop",
            };
            // Fail every in-flight request (their CLIs get a `res`) and tell the extension to stop them.
            {
                let mut st = sh.st.lock().unwrap();
                for (id, p) in st.pending.drain() {
                    p.out.send(err_res("proxy is shutting down")).ok();
                    p.ext.send(json!({"t":"cancel","id":id}).to_string()).ok();
                }
                bye(&mut st, reason);
            }
            sh.stop.notify_one();
            send(&mut ws, json!({"t":"ok"})).await
        }
        Some("req") => {
            sh.st.lock().unwrap().last = Instant::now();
            let r = request(sh, &mut ws, msg["req"].clone()).await;
            sh.st.lock().unwrap().last = Instant::now();
            r
        }
        _ => Ok(()),
    }
}

async fn request(sh: &Shared, ws: &mut Ws, req: Value) -> Result<()> {
    probe_ext(sh).await;
    let start = Instant::now();
    let mut told = false;
    let ext_tx = loop {
        let tx = sh.st.lock().unwrap().ext.as_ref().map(|e| (e.conn, e.tx.clone()));
        if let Some(t) = tx {
            break t;
        }
        // A worker that died restarts by itself: wait for it (until `wake_wait` after it was
        // dropped, at least `ext_wait`), and say so.
        let lost = sh.st.lock().unwrap().lost;
        let waited = start.elapsed() >= sh.ext_wait;
        if waited && lost.is_none_or(|t| t.elapsed() >= sh.wake_wait) {
            return send(ws, err_res(lost.map_or(NOT_CONNECTED, |_| WORKER_DEAD))).await;
        }
        if lost.is_some() && !told {
            told = true;
            let note = "browser extension stopped responding; waiting for it to restart (up to 30 s) …\n";
            send(ws, json!({"t":"event","stderr":note})).await?;
        }
        sleep(Duration::from_millis(50)).await;
    };
    let (owner, ext) = ext_tx;
    let (out, mut inbox) = mpsc::unbounded_channel();
    let id = {
        let mut st = sh.st.lock().unwrap();
        st.next += 1;
        let id = st.next;
        st.active += 1;
        st.pending.insert(
            id,
            Pending {
                owner,
                ext: ext.clone(),
                out,
            },
        );
        id
    };
    // Every exit path (return, `?`, dropped future) removes the entry and cancels it in the extension.
    let _guard = Guard { sh, id };
    if ext.send(json!({"t":"req","id":id,"req":req}).to_string()).is_err() {
        return send(ws, err_res("browser extension disconnected")).await;
    }
    loop {
        tokio::select! {
            m = inbox.recv() => match m {
                Some(v) => {
                    let done = v["t"] == "res";
                    send(ws, v).await?;
                    if done { return Ok(()); }
                }
                None => return Ok(()),
            },
            m = next_json(ws) => if m.is_none() { return Ok(()); },
        }
    }
}

/// Ends a request on every path: if it is still pending (not answered, not failed by disconnect/shutdown),
/// forget it and tell the extension to cancel.
struct Guard<'a> {
    sh: &'a Shared,
    id: u64,
}
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let mut st = self.sh.st.lock().unwrap();
        st.active -= 1;
        if let Some(p) = st.pending.remove(&self.id) {
            p.ext.send(json!({"t":"cancel","id":self.id}).to_string()).ok();
        }
    }
}
