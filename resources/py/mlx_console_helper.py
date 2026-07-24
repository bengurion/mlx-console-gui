#!/usr/bin/env python3
"""Cache + download helper for the MLX Console VS Code extension.

Runs inside the extension-managed virtualenv (where huggingface_hub is present as
a dependency of mlx-lm). Commands:

  scan                    -> {"ok": true, "models": [...]}            (single JSON line)
  delete --repo <id>      -> {"ok": true, "freedBytes": N}           (single JSON line)
  download --repo <id>    -> NDJSON progress events, one per line

All output is JSON so the TypeScript side can parse it deterministically.
"""

import argparse
import datetime
import json
import os
import shutil
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _cache_info():
    """scan_cache_dir(), or None when the cache directory does not exist yet.

    A freshly configured models directory has no `hub/` subfolder until the first
    download, and huggingface_hub raises CacheNotFound in that case.
    """
    from huggingface_hub import scan_cache_dir

    try:
        return scan_cache_dir()
    except Exception as exc:  # noqa: BLE001
        if type(exc).__name__ in ("CacheNotFound", "FileNotFoundError"):
            return None
        raise


def _dir_stats(path):
    """Total bytes and file count under a directory."""
    size = 0
    files = 0
    for root, _dirs, names in os.walk(path):
        for name in names:
            try:
                size += os.path.getsize(os.path.join(root, name))
                files += 1
            except OSError:
                pass
    return size, files


def scan_local(roots):
    """Models that live as plain directories rather than in the HF cache.

    Conversion writes here, and `scan_cache_dir()` cannot see it — so without
    this a converted model was invisible to the Models page and there was no
    way to launch the thing you had just spent an hour making. A directory
    counts as a model when it holds a config.json and at least one safetensors
    file, which is what mlx-lm itself requires to load one.
    """
    models = []
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            path = os.path.join(root, name)
            if not os.path.isdir(path):
                continue
            entries = os.listdir(path)
            if "config.json" not in entries:
                continue
            if not any(e.endswith(".safetensors") for e in entries):
                continue
            size, files = _dir_stats(path)
            last = None
            try:
                last = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat()
            except Exception:
                pass
            models.append(
                {
                    # The path is the identifier: it is what mlx-lm loads and
                    # what the server is started with.
                    "repo": path,
                    "sizeBytes": size,
                    "nbFiles": files,
                    "lastModified": last,
                    "path": path,
                    "local": True,
                }
            )
    return models


def scan(local_roots=()):
    info = _cache_info()
    if info is None:
        emit({"ok": True, "models": scan_local(local_roots)})
        return
    models = list(scan_local(local_roots))
    for repo in info.repos:
        if repo.repo_type != "model":
            continue
        last = None
        try:
            last = datetime.datetime.fromtimestamp(repo.last_modified).isoformat()
        except Exception:
            pass
        models.append(
            {
                "repo": repo.repo_id,
                "sizeBytes": int(repo.size_on_disk),
                "nbFiles": int(repo.nb_files),
                "lastModified": last,
                "path": str(repo.repo_path),
            }
        )
    emit({"ok": True, "models": models})


def delete(repo_id, local_roots=()):
    # A converted model is a directory, not a cache revision; deleting it is a
    # different operation. Only ever inside a root we were given, so a bad id
    # cannot remove anything else.
    if os.path.isabs(repo_id):
        target = os.path.realpath(repo_id)
        allowed = any(
            target.startswith(os.path.realpath(r) + os.sep) for r in local_roots if r
        )
        if not allowed:
            emit({"ok": False, "error": "Refusing to delete a path outside the models directory"})
            return
        if not os.path.isdir(target):
            emit({"ok": False, "error": "Model directory not found"})
            return
        freed, _ = _dir_stats(target)
        shutil.rmtree(target)
        emit({"ok": True, "freedBytes": freed})
        return

    info = _cache_info()
    if info is None:
        emit({"ok": False, "error": "Model cache directory does not exist yet"})
        return
    hashes = []
    freed = 0
    for repo in info.repos:
        if repo.repo_id == repo_id and repo.repo_type == "model":
            freed = int(repo.size_on_disk)
            for rev in repo.revisions:
                hashes.append(rev.commit_hash)
    if not hashes:
        emit({"ok": False, "error": "Model not found in cache"})
        return
    info.delete_revisions(*hashes).execute()
    emit({"ok": True, "freedBytes": freed})


def top():
    """Who is holding the memory, and how full the models volume is.

    psutil is a soft dependency: without it this answers ok with an empty
    process list rather than failing, so the dashboard degrades instead of
    erroring on venvs installed before psutil joined the environment.
    """
    out = {"ok": True, "processes": []}

    models_root = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
    try:
        usage = shutil.disk_usage(models_root if os.path.isdir(models_root) else os.path.expanduser("~"))
        out["disk"] = {"path": models_root, "totalBytes": usage.total, "freeBytes": usage.free}
    except OSError:
        pass

    try:
        import psutil
    except ImportError:
        emit(out)
        return

    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            rss = p.info["memory_info"].rss if p.info["memory_info"] else 0
            if rss <= 0:
                continue
            procs.append({"pid": p.info["pid"], "name": p.info["name"] or "?", "rssBytes": rss})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: -x["rssBytes"])
    procs = procs[:10]

    # cpu_percent needs two samples with a gap; prime, wait briefly, read.
    handles = {}
    for entry in procs:
        try:
            h = psutil.Process(entry["pid"])
            h.cpu_percent(None)
            handles[entry["pid"]] = h
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    import time

    time.sleep(0.35)
    for entry in procs:
        h = handles.get(entry["pid"])
        try:
            entry["cpuPercent"] = round(h.cpu_percent(None), 1) if h else 0.0
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            entry["cpuPercent"] = 0.0

    out["processes"] = procs
    emit(out)


def _repo_cache_dir(repo_id):
    """Where this repo's bytes land while hf_hub_download runs."""
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        base = HF_HUB_CACHE
    except Exception:  # noqa: BLE001
        base = os.path.join(
            os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub"
        )
    return os.path.join(base, "models--" + repo_id.replace("/", "--"))


def _sweep_stale_incompletes(repo_dir, max_age_s=3600):
    """Delete orphaned partial downloads before starting a fresh attempt.

    huggingface_hub >= 1.x names its temp files `<etag>.<random>.incomplete`,
    a fresh name per attempt — a killed process's file is never picked up
    again (resume happens through hf_xet's chunk cache instead), so each
    interruption of a large shard would otherwise leave gigabytes behind.
    The age guard keeps a concurrently running attempt's file safe: a live
    download touches its file constantly.
    """
    blobs = os.path.join(repo_dir, "blobs")
    now = time.time()
    try:
        names = os.listdir(blobs)
    except OSError:
        return
    for name in names:
        if not name.endswith(".incomplete"):
            continue
        path = os.path.join(blobs, name)
        try:
            if now - os.path.getmtime(path) > max_age_s:
                os.remove(path)
        except OSError:
            pass


def download(repo_id):
    import threading

    from huggingface_hub import HfApi, hf_hub_download

    api = HfApi()
    try:
        meta = api.model_info(repo_id, files_metadata=True)
    except Exception as exc:  # noqa: BLE001
        emit({"event": "error", "message": f"model_info failed: {exc}"})
        return

    files = [(s.rfilename, int(getattr(s, "size", 0) or 0)) for s in (meta.siblings or [])]
    total = sum(size for _, size in files)
    emit({"event": "start", "total": total, "nbFiles": len(files)})

    # hf_hub_download says nothing until a file is complete, and one
    # safetensors shard can be many gigabytes — a bar frozen at the previous
    # file for minutes reads as a hang. The bytes do land in the repo's cache
    # directory as they arrive (blobs/*.incomplete included), so a watcher on
    # that directory is the difference between a moving bar and a dead one.
    lock = threading.Lock()
    state = {"file": None, "best": 0}
    stop = threading.Event()

    def report(downloaded):
        with lock:
            # Monotonic: the per-file sum and the directory size disagree by a
            # partial file's worth, and a bar that steps backwards looks broken.
            state["best"] = max(state["best"], min(downloaded, total) if total else downloaded)
            payload = {"event": "progress", "downloaded": state["best"], "total": total}
            if state["file"]:
                payload["file"] = state["file"]
            emit(payload)

    repo_dir = _repo_cache_dir(repo_id)
    _sweep_stale_incompletes(repo_dir)

    def watch():
        while not stop.wait(1.0):
            size, _files = _dir_stats(repo_dir)
            report(size)

    if total:
        threading.Thread(target=watch, daemon=True).start()

    done = 0
    try:
        for fname, size in files:
            state["file"] = fname
            try:
                hf_hub_download(repo_id, fname)
            except Exception as exc:  # noqa: BLE001
                with lock:
                    emit({"event": "error", "message": f"{fname}: {exc}"})
                return
            done += size
            report(done)
    finally:
        stop.set()

    emit({"event": "done", "total": total})


def main():
    parser = argparse.ArgumentParser(prog="mlx_console_helper")
    sub = parser.add_subparsers(dest="cmd")
    sc = sub.add_parser("scan")
    sc.add_argument("--local", action="append", default=[])
    d = sub.add_parser("delete")
    d.add_argument("--repo", required=True)
    d.add_argument("--local", action="append", default=[])
    dl = sub.add_parser("download")
    dl.add_argument("--repo", required=True)
    sub.add_parser("top")

    args = parser.parse_args()
    if args.cmd == "scan":
        scan(args.local)
    elif args.cmd == "delete":
        delete(args.repo, args.local)
    elif args.cmd == "download":
        download(args.repo)
    elif args.cmd == "top":
        top()
    else:
        emit({"ok": False, "error": "unknown command"})
        sys.exit(2)


if __name__ == "__main__":
    main()
