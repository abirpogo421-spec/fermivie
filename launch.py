#!/usr/bin/env python3
"""Start Fermivie and open it in the browser (what the "Start Fermivie" files run).

- If Fermivie is already running with this library, it just opens it again.
- Otherwise it starts on port 8124, or the next free port if something else is using 8124.
- Keep the window it runs in open while you use the app; close it to stop.

Settings (environment variables, all optional):
  PORT=8200            first port to try (default 8124)
  LIBRARY_DIR=/path    where papers, marks and notes are kept (default: the library folder next to this file)
  PM_SEARCH_DIRS=...   folders searched for downloaded journal PDFs (overrides the setting)
  PM_NO_BROWSER=1      don't open a browser tab
Exit codes: 0 stopped normally, 1 couldn't start, 3 was already running (opened it instead).
Stdlib only.
"""
import json
import os
import signal
import socket
import sys
import threading
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = ".running.json"          # inside the library folder: which port serves it right now
_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never ask a proxy about localhost


def _ours(port):
    """Is a Fermivie answering on this port?"""
    try:
        with _direct.open(f"http://127.0.0.1:{port}/api/settings", timeout=1.5) as r:
            return json.load(r).get("ok") is True
    except Exception:
        return False


def _free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name != "nt":   # same as the server, so connections left over from a closed run don't count
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _open(url):
    if os.environ.get("PM_NO_BROWSER"):
        return
    try:
        webbrowser.open(url)
    except Exception:
        pass


def _path(p):
    """A path as people type it: quotes stripped, ~ expanded, relative to where they ran this."""
    p = p.strip().strip('"').strip("'")
    return os.path.abspath(os.path.expanduser(p)) if p else ""


def _read_lock(lib):
    try:
        with open(os.path.join(lib, LOCK), encoding="utf-8") as f:
            return int(json.load(f).get("port"))
    except Exception:
        return None


def _write_lock(lib, port):
    try:
        os.makedirs(lib, exist_ok=True)
        with open(os.path.join(lib, LOCK), "w", encoding="utf-8") as f:
            json.dump({"port": port, "pid": os.getpid()}, f)
    except OSError:
        pass


def _clear_lock(lib, port):
    if _read_lock(lib) == port:
        try:
            os.remove(os.path.join(lib, LOCK))
        except OSError:
            pass


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)   # messages show up at once, even in a log file
    except Exception:
        pass
    if sys.version_info < (3, 9):
        print("Fermivie needs Python 3.9 or newer; this is Python %d.%d." % sys.version_info[:2])
        print("Install a newer Python (python.org on Mac and Windows; your package manager on Linux) and try again.")
        return 1
    chosen = bool(os.environ.get("LIBRARY_DIR", "").strip())
    lib = _path(os.environ.get("LIBRARY_DIR", "")) or os.path.join(HERE, "library")
    os.environ["LIBRARY_DIR"] = lib
    if os.environ.get("PM_SEARCH_DIRS"):
        os.environ["PM_SEARCH_DIRS"] = os.pathsep.join(
            d for d in (_path(x) for x in os.environ["PM_SEARCH_DIRS"].split(os.pathsep)) if d)
    os.chdir(HERE)
    sys.path.insert(0, HERE)
    try:
        first = int(os.environ.get("PORT") or 8124)
    except ValueError:
        print("PORT must be a number.")
        return 1

    # already running with this library? just open it
    running = _read_lock(lib)
    if running and _ours(running):
        url = f"http://localhost:{running}"
        print(f"Fermivie is already running at {url}. Opened it in your browser.")
        _open(url)
        return 3
    port = None
    for p in range(first, first + 20):
        if _ours(p):
            if not chosen and running is None and p == first:
                # started some other way (no lock file): with the default library, assume it's this one
                url = f"http://localhost:{p}"
                print(f"Fermivie is already running at {url}. Opened it in your browser.")
                _open(url)
                return 3
            continue          # a Fermivie with another library
        if _free(p):
            port = p
            break
    if port is None:
        print(f"Ports {first}-{first + 19} are all in use. Set PORT to another number and try again.")
        return 1

    import server
    srv = server.make_server(port=port)
    _write_lock(lib, port)
    url = f"http://localhost:{port}"
    print()
    print(f"  Fermivie is running at {url}")
    print(f"  Library folder: {server.store.root}")
    print()
    print("  Keep this window open while you use it. To stop, close this window.")
    print()
    threading.Timer(0.6, _open, args=(url,)).start()

    def _stop(*_):
        raise KeyboardInterrupt
    for name in ("SIGTERM", "SIGHUP"):   # closing the window or a kill: still clean up the lock file
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), _stop)
            except (ValueError, OSError):
                pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        srv.server_close()
        _clear_lock(lib, port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
