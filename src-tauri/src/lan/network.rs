// 局域网 IP 探测。
//
// 通过创建 UDP "connect" 到一个公网地址（不发包）来让 OS 选出对应路由的源地址，
// 这是跨平台不引入额外依赖的最简实现 —— 不需要遍历网卡、解析 sysctl 等。
// 多网卡场景下能拿到主路由 IP；如果用户连了 VPN，可能拿到 VPN 网段 IP，仍然有效。
//
// 同时返回 LAN-class 私网检测：仅 RFC1918（10/8、172.16/12、192.168/16）
// 与链路本地（169.254/16）算"局域网可达"，否则提示用户检查网络。

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::Duration;

/// 返回当前主机所有可用的局域网 IPv4 地址。
/// 同时通过 8.8.8.8 / 114.114.114.114 两个公网目标探测主路由 IP，
/// 再用 hostname 反向查表把所有本地 IPv4 列出（去重）。
pub fn detect_lan_ipv4() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    // 探测主路由 IP（不会真的发包，只让内核选出路由源地址）
    for probe in &["8.8.8.8:80", "114.114.114.114:80", "1.1.1.1:80"] {
        if let Some(ip) = probe_route_ipv4(probe) {
            if !found.contains(&ip) {
                found.push(ip);
            }
        }
    }

    // 链路本地 fallback：当前机器没接路由（纯 LAN）时上面 connect 会失败，
    // 用 hostname 解析能拿到本机 IPv4
    if let Ok(hostname) = hostname_lookup() {
        for ip in hostname {
            if !found.contains(&ip) {
                found.push(ip);
            }
        }
    }

    found
}

fn probe_route_ipv4(target: &str) -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.set_read_timeout(Some(Duration::from_millis(200))).ok();
    socket.connect(target).ok()?;
    let local = socket.local_addr().ok()?;
    if let SocketAddr::V4(v4) = local {
        let ip = *v4.ip();
        if ip.is_unspecified() {
            return None;
        }
        return Some(ip.to_string());
    }
    None
}

fn hostname_lookup() -> std::io::Result<Vec<String>> {
    // 用 std::net::ToSocketAddrs 解析 "<hostname>:0"，把主机名对应的所有 A 记录拿出来。
    use std::net::ToSocketAddrs;
    let host = std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            // Windows 下 GUI 进程 spawn `hostname.exe` 会弹一个 conhost 黑框，
            // 用 configure_background_command 加 CREATE_NO_WINDOW 压掉。
            let mut command = std::process::Command::new("hostname");
            crate::agent::proc::configure_background_command(&mut command);
            command
                .output()
                .ok()
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "localhost".to_string());

    let mut out = Vec::new();
    if let Ok(iter) = format!("{host}:0").to_socket_addrs() {
        for sa in iter {
            if let IpAddr::V4(v4) = sa.ip() {
                if !v4.is_loopback() && !v4.is_unspecified() {
                    out.push(v4.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// 判断是否是 RFC1918 / 链路本地 IPv4。
pub fn is_lan_ipv4(ip_str: &str) -> bool {
    let Ok(ip) = ip_str.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let oct = ip.octets();
    // 10.0.0.0/8
    if oct[0] == 10 {
        return true;
    }
    // 172.16.0.0/12
    if oct[0] == 172 && (16..=31).contains(&oct[1]) {
        return true;
    }
    // 192.168.0.0/16
    if oct[0] == 192 && oct[1] == 168 {
        return true;
    }
    // 169.254.0.0/16 链路本地
    if oct[0] == 169 && oct[1] == 254 {
        return true;
    }
    false
}
