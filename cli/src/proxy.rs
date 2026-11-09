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
}
struct State {
    ext: Option<Ext>,
    pending: HashMap<u64, Pending>,
    /// `request` calls still running (they must flush their final message before the proxy exits).
    active: usize,
    next: u64,
    last: Instant,
}
struct Shared {
    secret: String,
    port: u16,
    idle: u64,
    ext_wait: Duration,
    st: Mutex<State>,
    stop: Notify,
}

pub fn run(secret: String, port: u16, idle: u64) -> Result<()> {
    let ext_wait = std::env::var("BCTL_EXT_WAIT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let sh = Arc::new(Shared {
        secret,
        port,
        idle,
        ext_wait: Duration::from_millis(ext_wait),
        st: Mutex::new(State {
            ext: None,
            pending: HashMap::new(),
            active: 0,
            next: 1,
            last: Instant::now(),
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
                // Let in-flight requests write their failure `res` to their CLIs first.
                for _ in 0..20 {
                    if sh.st.lock().unwrap().active == 0 { break; }
                    sleep(Duration::from_millis(50)).await;
                }
                return Ok(());
            }
            _ = tick.tick() => if sh.idle > 0 {
                let st = sh.st.lock().unwrap();
                if st.pending.is_empty() && st.last.elapsed() >= Duration::from_secs(sh.idle) {
                    log("idle timeout, exiting");
                    return Ok(());
                }
            },
        }
    }
}

async fn send(ws: &mut Ws, v: Value) -> Result<()> {
    Ok(ws.send(Message::text(v.to_string())).await?)
}

/// Next JSON text frame; None on close/error. Cancel-safe (keeps no state between polls).
async fn next_json(ws: &mut Ws) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str(t.as_str()) {
                    return Some(v);
                }
            }
            Ok(Message::Close(_)) | Err(_) => return None,
            _ => {}
        }
    }
}

fn err_res(msg: &str) -> Value {
    json!({"t":"res","res":{"exitCode":1,"stdout":"","stderr":format!("{msg}\n")}})
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
        send(&mut ws, fail("authentication failed (re-pair with `bctl pair`)"))
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
        st.ext = Some(Ext { conn: id, tx, info });
        id
    };
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(s) => if ws.send(Message::text(s)).await.is_err() { break },
                None => break,
            },
            m = next_json(&mut ws) => match m {
                None => break,
                Some(v) => route(sh, &v),
            },
        }
    }
    ws.close(None).await.ok();
    let mut st = sh.st.lock().unwrap();
    if st.ext.as_ref().is_some_and(|e| e.conn == id) {
        st.ext = None;
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
            // Fail every in-flight request (their CLIs get a `res`) and tell the extension to stop them.
            {
                let mut st = sh.st.lock().unwrap();
                for (id, p) in st.pending.drain() {
                    p.out.send(err_res("proxy is shutting down")).ok();
                    p.ext.send(json!({"t":"cancel","id":id}).to_string()).ok();
                }
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
    let start = Instant::now();
    let ext_tx = loop {
        let tx = sh.st.lock().unwrap().ext.as_ref().map(|e| (e.conn, e.tx.clone()));
        if let Some(t) = tx {
            break t;
        }
        if start.elapsed() >= sh.ext_wait {
            return send(ws, err_res("browser extension is not connected. Open Chrome with the Browser Bridge extension installed and paired.")).await;
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
