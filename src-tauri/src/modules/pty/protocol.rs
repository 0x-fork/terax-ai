//! The `terax-pty` custom URI scheme: the HTTP-shaped edge of the PTY hub.
//!
//! `POST /poll` is held open until output is due; `POST /ack` applies
//! acknowledgements and returns at once. Both carry the stream token from
//! `pty_stream_open` in their binary body (see `wire`). The token, not the
//! caller's origin, is the credential: any frame in the webview can reach this
//! scheme, but only the page's own frame can invoke the command that issues
//! the token.
//!
//! Frontend URL (see `convertFileSrc`): `terax-pty://localhost/poll` on
//! macOS and Linux, `http://terax-pty.localhost/poll` on Windows.

use std::sync::Arc;

use tauri::http::{self, header, Method, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::hub::{Command, Endpoint, Hub, Reply};
use super::wire::decode_request;
use super::PtyState;

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Preflight,
    Stream(Endpoint),
    Reject(StatusCode, &'static str),
}

fn route(method: &Method, path: &str) -> Route {
    if method == Method::OPTIONS {
        return Route::Preflight;
    }
    let endpoint = match path {
        "/poll" => Endpoint::Poll,
        "/ack" => Endpoint::Ack,
        _ => return Route::Reject(StatusCode::NOT_FOUND, "unknown terax-pty endpoint"),
    };
    if method != Method::POST {
        return Route::Reject(StatusCode::METHOD_NOT_ALLOWED, "only POST is allowed");
    }
    Route::Stream(endpoint)
}

fn http_response(status: u16, body: Vec<u8>) -> http::Response<Vec<u8>> {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    if status == StatusCode::NO_CONTENT {
        // The hub never answers 204; it is the CORS preflight verdict.
        return preflight_response();
    }
    let content_type = if status == StatusCode::OK {
        "application/octet-stream"
    } else {
        "text/plain"
    };
    http::Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // Output is one-shot: never cached, never sniffed.
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .expect("static response headers are valid")
}

fn preflight_response() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "*")
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .body(Vec::new())
        .expect("static response headers are valid")
}

struct TauriReply(UriSchemeResponder);

impl Reply for TauriReply {
    fn send(self: Box<Self>, status: u16, body: Vec<u8>) {
        self.0.respond(http_response(status, body));
    }
}

/// Registered with `register_asynchronous_uri_scheme_protocol("terax-pty", ..)`.
/// Runs on the webview's main thread, so it only validates and enqueues; the
/// hub thread does the work and answers through the responder.
pub fn stream_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let Some(state) = ctx.app_handle().try_state::<PtyState>() else {
        responder.respond(http_response(503, b"PTY transport unavailable".to_vec()));
        return;
    };
    dispatch(
        &state.hub,
        ctx.webview_label(),
        request.method(),
        request.uri().path(),
        request.body(),
        Box::new(TauriReply(responder)),
    );
}

fn dispatch(
    hub: &Hub,
    label: &str,
    method: &Method,
    path: &str,
    body: &[u8],
    reply: Box<dyn Reply>,
) {
    match route(method, path) {
        Route::Preflight => reply.send(StatusCode::NO_CONTENT.as_u16(), Vec::new()),
        Route::Reject(status, message) => reply.send(status.as_u16(), message.as_bytes().to_vec()),
        Route::Stream(endpoint) => match decode_request(body) {
            Ok(request) => hub.submit(Command::Request {
                label: Arc::from(label),
                endpoint,
                request,
                reply,
            }),
            Err(error) => reply.send(400, error.to_string().into_bytes()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pty::wire::{encode_request, Ack};
    use std::sync::mpsc;
    use std::time::Duration;

    struct Capture(mpsc::Sender<(u16, Vec<u8>)>);

    impl Reply for Capture {
        fn send(self: Box<Self>, status: u16, body: Vec<u8>) {
            let _ = self.0.send((status, body));
        }
    }

    fn call(hub: &Hub, method: Method, path: &str, body: &[u8]) -> (u16, Vec<u8>) {
        let (tx, rx) = mpsc::channel();
        dispatch(hub, "main", &method, path, body, Box::new(Capture(tx)));
        rx.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn only_post_to_known_endpoints_reaches_the_hub() {
        assert_eq!(route(&Method::POST, "/poll"), Route::Stream(Endpoint::Poll));
        assert_eq!(route(&Method::POST, "/ack"), Route::Stream(Endpoint::Ack));
        assert_eq!(route(&Method::OPTIONS, "/poll"), Route::Preflight);
        assert_eq!(route(&Method::OPTIONS, "/anything"), Route::Preflight);
        assert!(matches!(
            route(&Method::GET, "/poll"),
            Route::Reject(StatusCode::METHOD_NOT_ALLOWED, _)
        ));
        assert!(matches!(
            route(&Method::POST, "/poll/extra"),
            Route::Reject(StatusCode::NOT_FOUND, _)
        ));
        assert!(matches!(
            route(&Method::POST, ""),
            Route::Reject(StatusCode::NOT_FOUND, _)
        ));
    }

    #[test]
    fn responses_are_uncacheable_cors_readable_binary() {
        let ok = http_response(200, vec![1, 2, 3]);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(
            ok.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(ok.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(ok.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let err = http_response(403, Vec::new());
        assert_eq!(err.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(http_response(9999, Vec::new()).status(), 500);
        let preflight = http_response(204, Vec::new());
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "POST, OPTIONS"
        );
    }

    #[test]
    fn malformed_bodies_are_rejected_at_the_boundary_without_reaching_the_hub() {
        let hub = Hub::new();
        let good = encode_request(7, &[Ack { id: 1, bytes: 2 }]);
        for body in [
            Vec::new(),
            good[..11].to_vec(),
            good[..good.len() - 1].to_vec(),
            [good.clone(), vec![0]].concat(),
            vec![0xff; 4096],
        ] {
            let (status, message) = call(&hub, Method::POST, "/poll", &body);
            assert_eq!(status, 400, "{body:?}");
            assert!(!message.is_empty());
        }
        assert_eq!(call(&hub, Method::GET, "/poll", &good).0, 405);
        assert_eq!(call(&hub, Method::POST, "/other", &good).0, 404);
        assert_eq!(call(&hub, Method::OPTIONS, "/poll", &[]).0, 204);
    }

    #[test]
    fn a_well_formed_request_without_a_valid_token_is_forbidden() {
        let hub = Hub::new();
        let body = encode_request(0xABCD, &[Ack { id: 99, bytes: 5 }]);
        assert_eq!(call(&hub, Method::POST, "/ack", &body).0, 403);
        assert_eq!(call(&hub, Method::POST, "/poll", &body).0, 403);
    }

    #[test]
    fn a_valid_token_authorizes_ack_requests_and_unknown_ids_are_ignored() {
        let hub = Hub::new();
        let (tx, rx) = mpsc::channel();
        hub.submit(Command::OpenStream {
            label: Arc::from("main"),
            reply: Box::new(move |token| tx.send(token).unwrap()),
        });
        let token = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let body = encode_request(token, &[Ack { id: 99, bytes: 5 }]);
        assert_eq!(call(&hub, Method::POST, "/ack", &body), (200, Vec::new()));
        // Another webview cannot use this token.
        let (tx, rx) = mpsc::channel();
        dispatch(
            &hub,
            "settings",
            &Method::POST,
            "/ack",
            &body,
            Box::new(Capture(tx)),
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().0, 403);
    }
}
