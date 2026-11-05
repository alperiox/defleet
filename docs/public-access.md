# Exposing the hub through a tunnel

> This is the generic runbook. Replace `<YOUR-DOMAIN>` with a domain you control, `<HUB-IP>` with the tailnet or LAN
> address of the hub machine, and `<YOUR-USER>` with your account name. Nothing here is specific to one deployment.

This runbook documents how the Agent Fleet hub on the host Mac is exposed securely over an outbound-only Cloudflare Tunnel at `https://<YOUR-DOMAIN>`. This enables agents and human access across local machines, external cloud workers, and remote devices regardless of whether Tailscale or corporate VPNs are active.

---

## 1. Architecture & Security Model

- **Outbound-only Tunnel**: The Mac runs `cloudflared` connecting outward to Cloudflare's edge. No inbound firewall ports or public IP addresses are opened on the local network.
- **TLS & Edge Termination**: Cloudflare terminates TLS at `https://<YOUR-DOMAIN>` with managed certificates.
- **Reverse Proxy Header**: Cloudflare attaches `CF-Connecting-IP` and `X-Forwarded-Proto: https`. The hub's `HUB_TRUST_PROXY=1` configuration ensures rate limiters and audit logs accurately record the client IP rather than Cloudflare's edge IP.
- **Authentication**:
  - Web UI: Authenticated via the human bearer token stored locally in `localStorage` (and optionally protected by Cloudflare Access email OTP).
  - API Routes (`/api/*`, `/mcp`, `/device/*`, agent endpoints): Authenticated via cryptographically constant-time validated bearer tokens and single-use event stream tickets (`/api/events/ticket`).

---

## 2. Prerequisites

1. **Host Mac**: Running the hub on port `8787` (repository at `~/agent-fleet`).
2. **Database Backup**: `fleet.db` backed up via SQLite online backup before changes:
   ```bash
   sqlite3 ~/agent-fleet/fleet.db ".backup ~/agent-fleet-backups/fleet.db.pre-tunnel-$(date +%Y%m%dT%H%M%SZ).bak"
   sqlite3 ~/agent-fleet/fleet.db.pre-tunnel.bak "pragma integrity_check"
   ```
3. **Hardening Prerequisites (AGEN-11)**:
   - Constant-time token checks (`crypto.timingSafeEqual`).
   - Failure-budget rate limiter on authenticated route families.
   - Single-use 60s event stream tickets for SSE (`/api/events/ticket`).
   - `HUB_TRUST_PROXY=1` support for `CF-Connecting-IP`.
4. **Cloudflare Tooling**:
   - `cloudflared` installed on Mac: `brew install cloudflared` (verified at `/opt/homebrew/bin/cloudflared`).
   - Cloudflare account with zone `<YOUR-DOMAIN>` active.

---

## 3. Installation & Configuration Steps

### Step 1: Account Login (Human Step)

On the host Mac (or via SSH to Mac), initiate Cloudflare authentication:
```bash
cloudflared tunnel login
```
This opens the browser authorization flow on Cloudflare. Select the domain **`<YOUR-DOMAIN>`**. Once confirmed, Cloudflare downloads the account certificate to:
`~/.cloudflared/cert.pem`

### Step 2: Create Named Tunnel

Create the named tunnel `hub`:
```bash
cloudflared tunnel create hub
```
This outputs the tunnel UUID (e.g. `<TUNNEL_ID>`) and saves credentials to:
`~/.cloudflared/<TUNNEL_ID>.json`

Verify with:
```bash
cloudflared tunnel list
```

### Step 3: Configure Ingress Rules

Create configuration file at `~/.cloudflared/config.yml`.

> [!IMPORTANT]
> **Staged Transition**: During initial setup and client migration, point `service` to the tailnet address (`http://<TAILNET-IP>:8787`) so the hub can remain bound to Tailscale while existing clients and helpers continue working. Repoint to `http://127.0.0.1:8787` **only** after all clients migrate and the human confirms connectivity with Tailscale off.

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /Users/<YOUR-USER>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <YOUR-DOMAIN>
    # Initial / transition phase:
    service: http://<TAILNET-IP>:8787
    # Post-migration loopback lockdown (final step):
    # service: http://127.0.0.1:8787
    originRequest:
      noTLSVerify: false
      connectTimeout: 30s
      keepAliveTimeout: 1m30s
      noChunkedEncoding: false
  - service: http_status:404
```

### Step 4: Configure DNS Route

Route `<YOUR-DOMAIN>` CNAME directly to the tunnel:
```bash
cloudflared tunnel route dns hub <YOUR-DOMAIN>
```

### Step 5: Hub Environment & Staged Migration Sequence

To prevent stranding active agents, helpers, and enrolled devices that talk to `http://<TAILNET-IP>:8787`, rollout is performed in discrete phases:

#### Phase 1: Dual-Reachability (Current Active State)
- `cloudflared` runs as a LaunchAgent proxying `<YOUR-DOMAIN>` -> `http://<TAILNET-IP>:8787`.
- Hub remains bound to `HUB_HOST=<TAILNET-IP>`.
- All existing agents and helpers continue operating against `http://<TAILNET-IP>:8787` without disruption.
- Public URL `https://<YOUR-DOMAIN>` is live, verified for UI (200) and unauthenticated routes (401).

#### Phase 2: Hub Configuration with Public URL (AGEN-14)
- Land `HUB_PUBLIC_URL` support.
- In `~/agent-fleet/.env` on the Mac:
  ```bash
  # Keep bound to tailnet during migration:
  HUB_HOST=<TAILNET-IP>
  PORT=8787

  # Public URL used in join prompts and client connection strings
  HUB_PUBLIC_URL=https://<YOUR-DOMAIN>

  # Trust CF-Connecting-IP from Cloudflare Tunnel
  HUB_TRUST_PROXY=1

  # Hub owner & secrets
  HUB_OWNER=alper
  ```
- Hub is restarted cleanly by the hub maintainer (`claude-1`).

#### Phase 3: Client Migration
- Migrate agents and CLI clients on each machine to the public URL:
  ```bash
  fleet login https://<YOUR-DOMAIN> <TOKEN>
  ```
- Re-enroll devices if needed (`fleet device enroll`).
- Verify helpers and agents connect and maintain heartbeat over `https://<YOUR-DOMAIN>`.

#### Phase 4: Human Verification (Tailscale Off)
- Human turns off Tailscale on client laptop / mobile device.
- Verifies:
  - `https://<YOUR-DOMAIN>` UI loads cleanly.
  - Live EventSource streaming delivers changes in real time.
  - Agent actions and replies function normally.

#### Phase 5: Final Loopback Lockdown
- Only after Phase 4 is verified:
  1. In `~/agent-fleet/.env`, switch `HUB_HOST`:
     ```bash
     HUB_HOST=127.0.0.1
     ```
  2. Maintainer restarts hub.
  3. Update `~/.cloudflared/config.yml` on Mac:
     ```yaml
     service: http://127.0.0.1:8787
     ```
  4. Reload cloudflared service:
     ```bash
     launchctl kickstart -k gui/$(id -u <YOUR-USER>)/com.cloudflare.cloudflared
     ```

### Step 6: Install and Start `launchd` Service

To ensure `cloudflared` starts automatically on boot and recovers from crashes without an active terminal:

Create `~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.cloudflared</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>/Users/<YOUR-USER>/.cloudflared/config.yml</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/<YOUR-USER>/.cloudflared/tunnel.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/<YOUR-USER>/.cloudflared/tunnel.err</string>
</dict>
</plist>
```

Load and start the service:
```bash
launchctl load ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
launchctl start com.cloudflare.cloudflared
```

---

## 4. Verification Checklist

Execute these checks after starting the service:

1. **UI Availability**:
   ```bash
   curl -sI https://<YOUR-DOMAIN> | grep -E "HTTP/|content-type:"
   # Expected: HTTP/2 200, text/html
   ```

2. **Security & Authentication Refusal**:
   ```bash
   curl -sI https://<YOUR-DOMAIN>/api/state | grep -E "HTTP/|WWW-Authenticate"
   # Expected: HTTP/2 401 Unauthorized
   ```

3. **EventSource Streaming (No buffering)**:
   Verify SSE stream connects and sends initial event without buffering:
   ```bash
   curl -N -H "Authorization: Bearer <HUMAN_TOKEN>" https://<YOUR-DOMAIN>/api/events
   # Expected: event: change, data: ... within 500ms
   ```

4. **Client Connection over Public URL**:
   Test CLI client enrollment and status check:
   ```bash
   fleet login https://<YOUR-DOMAIN> <HUMAN_TOKEN>
   fleet status
   ```

5. **VPN Independence**:
   - Turn Tailscale off on client device or connect company VPN.
   - Open `https://<YOUR-DOMAIN>` in browser. Confirm UI loads and live state updates.

---

## 5. Rollback Procedure & Tailnet Fallback

If an issue occurs during migration, or if public access must be decommissioned:

### Scenario A: Reverting Loopback Lockdown back to Tailnet (Immediate Fallback)
If the hub was set to `HUB_HOST=127.0.0.1` and any client or agent is unable to connect:
1. **Revert Hub Bindings to Tailnet**:
   In `~/agent-fleet/.env` on the Mac:
   ```bash
   HUB_HOST=<TAILNET-IP>
   ```
2. **Restart the Hub**:
   Follow maintainer deploy procedure (backup `fleet.db`, restart process).
3. **Revert Ingress in `config.yml`** (if tunnel is still desired):
   Change `service` in `~/.cloudflared/config.yml` back to `http://<TAILNET-IP>:8787`.
   Kickstart cloudflared:
   ```bash
   launchctl kickstart -k gui/$(id -u <YOUR-USER>)/com.cloudflare.cloudflared
   ```
4. **Revert Client Configurations** (if needed):
   ```bash
   fleet login http://<TAILNET-IP>:8787 <TOKEN>
   ```

### Scenario B: Fully Decommissioning Cloudflare Tunnel
To completely remove public tunnel access and return to pure tailnet-only operation:
1. **Stop & Unload the LaunchAgent Service**:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
   ```
2. **Remove DNS CNAME Route**:
   ```bash
   cloudflared tunnel route dns -d <YOUR-DOMAIN>
   ```
3. **Ensure Hub Environment is Tailnet-Only**:
   In `~/agent-fleet/.env`:
   ```bash
   HUB_HOST=<TAILNET-IP>
   HUB_TRUST_PROXY=0
   ```
   Restart hub process.
4. **Clean Up Client Configuration**:
   Ensure all helpers and devices have login pointing to `http://<TAILNET-IP>:8787`.

---

## 6. Rotation & Maintenance

- **Credential Rotation**: To rotate tunnel credentials:
  ```bash
  cloudflared tunnel token --rotate hub
  ```
  Or delete and recreate the named tunnel:
  ```bash
  cloudflared tunnel delete hub
  cloudflared tunnel create hub
  ```
- **Updating `cloudflared`**:
  ```bash
  brew upgrade cloudflared
  launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared
  ```
- **Checking Logs**:
  ```bash
  tail -f ~/.cloudflared/tunnel.log
  tail -f ~/agent-fleet/hub.log
  ```
