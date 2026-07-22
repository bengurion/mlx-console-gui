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
import sys


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


def scan():
    info = _cache_info()
    if info is None:
        emit({"ok": True, "models": []})
        return
    models = []
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


def delete(repo_id):
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


def download(repo_id):
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

    done = 0
    for fname, size in files:
        try:
            hf_hub_download(repo_id, fname)
        except Exception as exc:  # noqa: BLE001
            emit({"event": "error", "message": f"{fname}: {exc}"})
            return
        done += size
        emit({"event": "progress", "downloaded": done, "total": total, "file": fname})

    emit({"event": "done", "total": total})


def main():
    parser = argparse.ArgumentParser(prog="mlx_console_helper")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("scan")
    d = sub.add_parser("delete")
    d.add_argument("--repo", required=True)
    dl = sub.add_parser("download")
    dl.add_argument("--repo", required=True)

    args = parser.parse_args()
    if args.cmd == "scan":
        scan()
    elif args.cmd == "delete":
        delete(args.repo)
    elif args.cmd == "download":
        download(args.repo)
    else:
        emit({"ok": False, "error": "unknown command"})
        sys.exit(2)


if __name__ == "__main__":
    main()
