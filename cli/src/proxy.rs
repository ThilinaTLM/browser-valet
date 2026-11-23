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
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{handshake::server::*, http, Message};
use tokio_tungstenite::WebSocketStream;

/// The only extension origin allowed to connect as role `ext` (derived from the key in manifest.json).
const EXT_ORIGIN: &str = "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm";

type Ws = WebSocketStream<TcpStream>;

/// A live extension sends a `ping` at least every 20 s (only after an extension API call returned). Silent
/// for longer than `BVL_EXT_SILENT_MS` (default this): dead.
const EXT_SILENT_MS: u64 = 50_000;
/// How long a liveness `ping` may stay unanswered before `status` / `req` treat the extension as dead
/// (`BVL_EXT_PROBE_MS`; 0 turns probing off). A browser keeps a dead service worker's socket open.
const PROBE_MS: u64 = 2_500;
/// A dead worker is gone for up to ~30 s before Chrome stops it, then waits for the next 30 s alarm.
const WAKE_WAIT_MS: u64 = 65_000;

/// Shown to the agent when no extension is connected. The usual cause is the switch being off.
pub const NOT_CONNECTED: &str =
    "browser extension is not connected. It is switched off by default, and switches itself off \
when bvl stops or has been idle, and when the browser restarts. Ask the user to click the Browser Valet icon in their \
browser and switch it on, then retry. If it was never installed, the user runs `bvl setup` first.";

/// Shown when the extension stopped answering and did not come back in time.
pub const WORKER_DEAD: &str = "browser extension stopped responding and did not restart in time. Its background worker was \
terminated by the browser (this happens when a controlled tab is closed). Opening the Browser Valet popup or any browser \
activity wakes it; then retry.";

/// Why the proxy lost the extension while it was (probably) still switched on.
struct Lost {
    at: Instant,
    /// `unresponsive` (no answer to a ping / silent too long) or `vanished` (connection ended without a close frame).
    reason: &'static str,
}

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
    /// When the last `ping`/`pong` arrived. Other frames do not count: a wedged worker can still answer
    /// (or finish) a request while every extension API call hangs, and only a `ping`/`pong` proves otherwise.
    alive: Instant,
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
    /// The extension was lost without being switched off (cleared when one connects, ignored after `wake_wait`).
    lost: Option<Lost>,
}
struct Shared {
    secret: String,
    port: u16,
    idle: u64,
    ext_wait: Duration,
    /// How long a request waits for an extension whose worker died to restart.
    wake_wait: Duration,
    /// `BVL_EXT_PROBE_MS`: zero = never probe.
    probe_wait: Duration,
    silent: Duration,
    st: Mutex<State>,
    stop: Notify,
    /// Notified when a `ping`/`pong` arrives.
    alive: Notify,
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
        probe_wait: ms("BVL_EXT_PROBE_MS", PROBE_MS),
        silent: ms("BVL_EXT_SILENT_MS", EXT_SILENT_MS),
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
        alive: Notify::new(),
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
                tick_ext(&sh);
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

/// Once a tick: drop an extension that has not sent a `ping`/`pong` for `silent`, forget an expired `lost`.
fn tick_ext(sh: &Shared) {
    let mut st = sh.st.lock().unwrap();
    if st.lost.as_ref().is_some_and(|l| l.at.elapsed() >= sh.wake_wait) {
        st.lost = None;
    }
    let silent = st
        .ext
        .as_ref()
        .filter(|e| e.alive.elapsed() >= sh.silent)
        .map(|e| e.conn);
    if let Some(conn) = silent {
        drop_conn(&mut st, conn, "unresponsive");
    }
}

/// Drop extension connection `conn` (if it is still the current one): its pending requests fail (the
/// connection loop ends) and `lost` records why. The `bye restart` is for a worker that is alive but slow: it
/// reconnects instead of switching itself off; a dead one never reads it.
fn drop_conn(st: &mut State, conn: u64, reason: &'static str) {
    if st.ext.as_ref().is_some_and(|e| e.conn == conn) {
        bye(st, "restart");
        st.lost = Some(Lost {
            at: Instant::now(),
            reason,
        });
        log(&format!(
            "extension stopped answering ({reason}), dropped its connection"
        ));
    }
}

/// Extensions of another version than the bundled one (dev builds, an update in progress) may predate
/// `ping`/`pong`: they cannot be probed. Their own 20 s pings still feed the silence limit.
fn probeable(info: &Value) -> bool {
    EMBEDDED_EXT_VERSION.is_none_or(|v| info["extVersion"].as_str() == Some(v))
}

/// Check the extension connection is live: it must answer a `ping` (which it does only after an extension
/// API call returned). True when it did, or when there is nothing to check. False when it did not: the
/// connection is then dropped, unless it has a request in flight and `drop_busy` is false (`status` stays
/// truthful without failing that request). Waits `BVL_EXT_PROBE_MS` (a worker busy with a request may be slow: four times as long then).
async fn probe_ext(sh: &Shared, drop_busy: bool) -> bool {
    let sent = Instant::now();
    let (conn, busy) = {
        let st = sh.st.lock().unwrap();
        let Some(e) = st.ext.as_ref() else { return true };
        if sh.probe_wait.is_zero() || !probeable(&e.info) {
            return true;
        }
        e.tx.send(json!({"t":"ping"}).to_string()).ok();
        (e.conn, st.pending.values().any(|p| p.owner == e.conn))
    };
    let deadline = tokio::time::Instant::now() + if busy { sh.probe_wait * 4 } else { sh.probe_wait };
    loop {
        // Register for the notification before looking, so one arriving in between is not missed.
        let n = sh.alive.notified();
        tokio::pin!(n);
        n.as_mut().enable();
        match sh.st.lock().unwrap().ext.as_ref() {
            Some(e) if e.conn == conn && e.alive <= sent => {}
            _ => return true, // answered, or gone / replaced by a newer connection (not ours to drop)
        }
        if tokio::time::timeout_at(deadline, n).await.is_err() {
            break;
        }
    }
    let mut st = sh.st.lock().unwrap();
    if st.ext.as_ref().is_none_or(|e| e.conn != conn) {
        return true; // replaced or gone while we waited
    }
    if drop_busy || !busy {
        drop_conn(&mut st, conn, "unresponsive");
    }
    false
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

/// Like `next_json`; sets `clean` when the peer ended the connection deliberately (a close frame other than
/// 1001 "going away"), as opposed to vanishing or being torn down, which is what a terminated worker does.
async fn next_json_noting(ws: &mut Ws, clean: &mut bool) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Text(t)) => {
                if let Ok(v) = serde_json::from_str(t.as_str()) {
                    return Some(v);
                }
            }
            Ok(Message::Close(f)) => {
                // A terminated worker closes with 1001 (going away); the extension's own `close()` sends none.
                *clean = f.is_none_or(|f| f.code != CloseCode::Away);
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
            alive: Instant::now(),
        });
        st.lost = None;
        st.exts += 1;
        id
    };
    sh.alive.notify_waiters(); // wakes a probe of the connection this one replaced
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
                    if matches!(v["t"].as_str(), Some("ping" | "pong")) {
                        if let Some(e) = sh.st.lock().unwrap().ext.as_mut().filter(|e| e.conn == id) {
                            e.alive = Instant::now();
                        }
                        sh.alive.notify_waiters();
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
            st.lost = Some(Lost {
                at: Instant::now(),
                reason: "vanished",
            });
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
            // `"probe": false`: the CLI's own version check, which must not wait for a ping.
            let alive = msg["probe"] == false || probe_ext(sh, false).await;
            let v = {
                let st = sh.st.lock().unwrap();
                let ext = st
                    .ext
                    .as_ref()
                    .filter(|_| alive)
                    .map_or(Value::Null, |e| e.info.clone());
                let lost = st.lost.as_ref().filter(|l| l.at.elapsed() < sh.wake_wait);
                let ext_lost = match (lost, alive) {
                    (Some(l), _) => Some((l.reason, l.at.elapsed())),
                    (None, false) => Some(("unresponsive", Duration::ZERO)),
                    _ => None,
                };
                let ext_lost = ext_lost.map_or(Value::Null, |(reason, age)| {
                json!({"reason":reason,"ageSecs":age.as_secs(),"waitSecs":sh.wake_wait.saturating_sub(age).as_secs()})
            });
                let proxy = json!({"version":VERSION,"pid":std::process::id(),"port":sh.port,"idleTimeoutSecs":sh.idle,"pending":st.pending.len()});
                json!({"t":"status","proxy":proxy,"ext":ext,"extLost":ext_lost})
            };
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
    probe_ext(sh, true).await;
    let start = Instant::now();
    let mut told = false;
    let ext_tx = loop {
        let tx = sh.st.lock().unwrap().ext.as_ref().map(|e| (e.conn, e.tx.clone()));
        if let Some(t) = tx {
            break t;
        }
        // A worker that died restarts by itself: wait for it (until `wake_wait` after it was lost, and at
        // least `ext_wait`), and say so. A loss older than `wake_wait` is no longer a reason to wait.
        let lost = sh
            .st
            .lock()
            .unwrap()
            .lost
            .as_ref()
            .is_some_and(|l| l.at.elapsed() < sh.wake_wait);
        if lost && !told {
            told = true;
            let note = format!(
                "browser extension stopped responding; waiting for it to restart (up to {} s) …\n",
                sh.wake_wait.as_secs()
            );
            send(ws, json!({"t":"event","stderr":note})).await?;
        }
        if !lost && start.elapsed() >= sh.ext_wait {
            return send(ws, err_res(if told { WORKER_DEAD } else { NOT_CONNECTED })).await;
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
