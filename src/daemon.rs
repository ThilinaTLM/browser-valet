//! Local relay: the extension connects in over WebSocket (`/ext`), the CLI posts
//! commands over HTTP (`/cmd`). Both sides authenticate with the shared token.

use crate::config;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

struct Ext {
    conn_id: u64,
    tx: mpsc::UnboundedSender<Message>,
    info: Value,
}

struct AppState {
    token: String,
    ext: Mutex<Option<Ext>>,
    /// request id -> (connection id, responder)
    pending: Mutex<HashMap<u64, (u64, oneshot::Sender<Value>)>>,
    next_id: AtomicU64,
    connected: watch::Sender<bool>,
}

type S = Arc<AppState>;

pub async fn run(port: u16) -> anyhow::Result<()> {
    let token = config::token()?;
    let (connected, _) = watch::channel(false);
    let state = Arc::new(AppState {
        token,
        ext: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        connected,
    });
    let app = Router::new()
        .route("/ext", get(ext_ws))
        .route("/cmd", post(cmd))
        .route("/status", get(status))
        .route("/shutdown", post(shutdown))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("bctl daemon listening on 127.0.0.1:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn authed(s: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| t == s.token)
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
}

#[derive(Deserialize)]
struct ExtQuery {
    token: Option<String>,
}

async fn ext_ws(
    ws: WebSocketUpgrade,
    Query(q): Query<ExtQuery>,
    headers: HeaderMap,
    State(s): State<S>,
) -> Response {
    let origin_ok = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|o| o.starts_with("chrome-extension://"));
    if !origin_ok {
        return (StatusCode::FORBIDDEN, "bad origin").into_response();
    }
    if q.token.as_deref() != Some(s.token.as_str()) {
        return unauthorized();
    }
    ws.max_message_size(256 << 20)
        .max_frame_size(256 << 20)
        .on_upgrade(move |sock| handle_ext(sock, s))
}

async fn handle_ext(sock: WebSocket, s: S) {
    let conn_id = s.next_id.fetch_add(1, Ordering::SeqCst);
    let (mut sink, mut stream) = sock.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    {
        let mut ext = s.ext.lock().await;
        if let Some(old) = ext.take() {
            let _ = old.tx.send(Message::Close(None));
        }
        *ext = Some(Ext { conn_id, tx, info: Value::Null });
    }
    s.connected.send_replace(true);
    eprintln!("extension connected (conn {conn_id})");

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || close {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        if let Some(id) = v.get("id").and_then(Value::as_u64) {
            if let Some((_, responder)) = s.pending.lock().await.remove(&id) {
                let _ = responder.send(v);
            }
        } else if v.get("type").and_then(Value::as_str) == Some("hello") {
            if let Some(e) = s.ext.lock().await.as_mut().filter(|e| e.conn_id == conn_id) {
                e.info = v;
            }
        }
    }

    writer.abort();
    {
        let mut ext = s.ext.lock().await;
        if ext.as_ref().map(|e| e.conn_id) == Some(conn_id) {
            *ext = None;
            s.connected.send_replace(false);
        }
    }
    // Fail in-flight requests for this connection (dropping the responder).
    s.pending.lock().await.retain(|_, (c, _)| *c != conn_id);
    eprintln!("extension disconnected (conn {conn_id})");
}

#[derive(Deserialize)]
struct CmdReq {
    cmd: String,
    #[serde(default)]
    args: Value,
    tab: Option<i64>,
    timeout_ms: Option<u64>,
    wait_ext_ms: Option<u64>,
}

fn fail(msg: &str) -> Response {
    Json(json!({ "ok": false, "error": msg })).into_response()
}

async fn cmd(State(s): State<S>, headers: HeaderMap, Json(req): Json<CmdReq>) -> Response {
    if !authed(&s, &headers) {
        return unauthorized();
    }
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(30_000));

    // Give a sleeping extension service worker a moment to (re)connect.
    let mut rx = s.connected.subscribe();
    if !*rx.borrow() {
        let wait = Duration::from_millis(req.wait_ext_ms.unwrap_or(0));
        let _ = tokio::time::timeout(wait, rx.wait_for(|c| *c)).await;
    }

    let id = s.next_id.fetch_add(1, Ordering::SeqCst);
    let (otx, orx) = oneshot::channel();
    {
        let ext = s.ext.lock().await;
        let Some(e) = ext.as_ref() else {
            return fail(
                "extension not connected (is it installed, enabled and configured with the token from `bctl token`?)",
            );
        };
        s.pending.lock().await.insert(id, (e.conn_id, otx));
        let msg = json!({ "id": id, "cmd": req.cmd, "args": req.args, "tab": req.tab });
        if e.tx.send(Message::Text(msg.to_string().into())).is_err() {
            s.pending.lock().await.remove(&id);
            return fail("extension connection closed");
        }
    }

    match tokio::time::timeout(timeout, orx).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(_)) => fail("extension disconnected while handling command"),
        Err(_) => {
            s.pending.lock().await.remove(&id);
            fail("timed out waiting for extension")
        }
    }
}

async fn status(State(s): State<S>, headers: HeaderMap) -> Response {
    if !authed(&s, &headers) {
        return unauthorized();
    }
    let ext = s.ext.lock().await;
    Json(json!({
        "ok": true,
        "daemon": { "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() },
        "extension": ext.as_ref().map(|e| e.info.clone()),
    }))
    .into_response()
}

async fn shutdown(State(s): State<S>, headers: HeaderMap) -> Response {
    if !authed(&s, &headers) {
        return unauthorized();
    }
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::process::exit(0);
    });
    Json(json!({ "ok": true })).into_response()
}
