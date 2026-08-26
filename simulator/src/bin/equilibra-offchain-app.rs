use anyhow::{anyhow, Result};
use equilibra_offchain_simulator::app::server::{build_router, build_state};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::str::FromStr;

/// Strict env parser: an absent variable yields the fallback, but a
/// present-yet-malformed value is a hard error — a typo like
/// `BENCHMARK_APP_PORT=31O0` must terminate the process with a message
/// instead of silently binding the default port.
fn env_parse_strict<T>(key: &str, fallback: T) -> Result<T>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(raw) => raw
            .trim()
            .parse::<T>()
            .map_err(|e| anyhow!("{key}={raw:?} is not a valid value: {e}")),
        Err(env::VarError::NotPresent) => Ok(fallback),
        Err(env::VarError::NotUnicode(_)) => Err(anyhow!("{key} is not valid unicode")),
    }
}

/// Classify a bind host as loopback. Accepts the literal loopback IPs,
/// `localhost`, and any address that parses to an IP whose `is_loopback`
/// holds (covers `::1` and `127.0.0.0/8`). A non-parseable, non-localhost
/// hostname is treated as NON-loopback (fail-closed).
fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn ensure_bind_host_allowed(host: &str, allow_public: bool) -> Result<()> {
    if host_is_loopback(host) || allow_public {
        return Ok(());
    }
    Err(anyhow!(
        "refusing to bind non-loopback host '{host}': the dashboard has no \
         authentication. Bind localhost, 127.0.0.1 (default), or ::1; set \
         BENCHMARK_APP_ALLOW_PUBLIC=1 only behind an auth-enforcing proxy."
    ))
}

/// Resolve the supported host forms without string-concatenating a socket
/// address. `SocketAddr::new` supplies the required brackets for IPv6, while
/// the `localhost` alias is pinned to IPv4 loopback and does not require DNS.
fn bind_addr_for_host(host: &str, port: u16) -> Result<SocketAddr> {
    let ip = if host.eq_ignore_ascii_case("localhost") {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        host.parse::<IpAddr>().map_err(|e| {
            anyhow!("Invalid bind host {host:?}: expected localhost or an IP literal: {e}")
        })?
    };
    Ok(SocketAddr::new(ip, port))
}

fn env_host_strict(key: &str, fallback: &str) -> Result<String> {
    match env::var(key) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(anyhow!("{key} is set but empty"));
            }
            Ok(trimmed.to_string())
        }
        Err(env::VarError::NotPresent) => Ok(fallback.to_string()),
        Err(env::VarError::NotUnicode(_)) => Err(anyhow!("{key} is not valid unicode")),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let base_dir = std::env::current_dir()?;
    let host = env_host_strict("BENCHMARK_APP_HOST", "127.0.0.1")?;
    // The dashboard exposes unauthenticated run-mutation and CPU-heavy
    // compute endpoints. Binding beyond loopback would let any reachable
    // client drive them, so a non-loopback host is refused unless the
    // operator explicitly acknowledges it via BENCHMARK_APP_ALLOW_PUBLIC=1
    // (documented as unsafe without an external auth layer).
    let allow_public = env::var("BENCHMARK_APP_ALLOW_PUBLIC").ok().as_deref() == Some("1");
    ensure_bind_host_allowed(&host, allow_public)?;
    let base_port = env_parse_strict::<u16>("BENCHMARK_APP_PORT", 3100)?;
    let port_tries = env_parse_strict::<u16>("BENCHMARK_APP_PORT_TRIES", 20)?;
    let max_concurrent_runs = env_parse_strict::<usize>("BENCHMARK_MAX_CONCURRENT_RUNS", 1)?;
    if max_concurrent_runs == 0 {
        return Err(anyhow!(
            "BENCHMARK_MAX_CONCURRENT_RUNS must be >= 1 (got 0)"
        ));
    }

    let state = build_state(base_dir.clone(), max_concurrent_runs).await?;
    let app = build_router(state);

    let mut last_error: Option<anyhow::Error> = None;
    for offset in 0..=port_tries {
        let port = base_port.saturating_add(offset);
        let addr = bind_addr_for_host(&host, port)?;

        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                println!("[app] server listening on http://{}", addr);
                axum::serve(listener, app.clone())
                    .await
                    .map_err(|e| anyhow!("HTTP server failed: {e}"))?;
                return Ok(());
            }
            Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
                last_error = Some(anyhow!("Address in use: {addr}"));
                continue;
            }
            Err(err) => {
                return Err(anyhow!("Failed to bind {addr}: {err}"));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("No free port for benchmark app")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_classification_and_public_gate_are_fail_closed() {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "127.2.3.4", "::1"] {
            assert!(host_is_loopback(host), "{host} should be loopback");
            ensure_bind_host_allowed(host, false).expect("loopback bind should be allowed");
        }

        for host in ["0.0.0.0", "::", "192.0.2.1", "public.example"] {
            assert!(!host_is_loopback(host), "{host} should not be loopback");
            assert!(ensure_bind_host_allowed(host, false).is_err());
            ensure_bind_host_allowed(host, true).expect("explicit public opt-in");
        }
    }

    #[test]
    fn bind_address_handles_localhost_ipv4_and_ipv6() {
        assert_eq!(
            bind_addr_for_host("localhost", 3100)
                .expect("localhost")
                .to_string(),
            "127.0.0.1:3100"
        );
        assert_eq!(
            bind_addr_for_host("127.0.0.1", 3100)
                .expect("IPv4 loopback")
                .to_string(),
            "127.0.0.1:3100"
        );
        assert_eq!(
            bind_addr_for_host("::1", 3100)
                .expect("IPv6 loopback")
                .to_string(),
            "[::1]:3100"
        );
        assert!(bind_addr_for_host("public.example", 3100).is_err());
    }
}
