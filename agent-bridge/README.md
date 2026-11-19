# Local agent bridge (optional)

Lets a program on your computer — a command-line tool or a coding agent — list
your tabs and close tabs by ID. It is **off by default**.

## How it works

1. In HiddenTabby's manager page, **Local agent access → Allow access** grants
   the optional `nativeMessaging` permission. Revoking it disconnects at once.
2. With the permission granted, HiddenTabby connects to the native-messaging
   host `hiddentabby_agent_bridge` (`host.py`), which the browser starts.
3. `host.py` listens on `$XDG_RUNTIME_DIR/hiddentabby-bridge.sock` (mode 0600,
   peer UID checked) and relays one JSON request per connection.
4. Only two operations exist: `list` (open tabs plus HiddenTabby groups and
   records) and `close` (by tab ID, through HiddenTabby's normal delete path;
   pinned tabs are never closed).

Trust boundary: any process running as your user can list tab titles and URLs
and close tabs while access is allowed. Nothing leaves the computer.

Requirements: Linux, Python 3, Chrome, Chromium or Brave.

## Try it

```bash
agent-bridge/install.sh <extension-id>   # ID from the extensions page; omit for the Web Store build
hiddentabby-tabs list                    # after Allow access in the manager
hiddentabby-tabs dupes                   # extra copies of identical URLs
hiddentabby-tabs close 123456 789012
agent-bridge/uninstall.sh
```

Raw protocol example:

```bash
echo '{"op":"list"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/hiddentabby-bridge.sock
```
