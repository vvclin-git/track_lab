"""Local Track Lab server and FFmpeg preview worker."""
import argparse
from bisect import bisect_left
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "previews"
TOKEN = secrets.token_urlsafe(32)
VIDEOS = {}
JOBS = {}
FFMPEG = None
TEMP = None
ID = re.compile(r"[a-f0-9]{64}")
PTS = re.compile(r"Parsed_showinfo.*?\bpts:\s*(-?\d+)")


def cached_preview(output, target):
    return next((output / str(target)).glob("*.jpg"), None)


def make_previews(job, video, requests, tolerance):
    output = CACHE / video.name / str(tolerance)
    output.mkdir(parents=True, exist_ok=True)
    pending = []
    matches = {}
    for target in requests:
        image = cached_preview(output, target)
        if image:
            matches[target] = int(image.stem)
        else:
            pending.append(target)
    job.update(reused=len(matches), processed=0, failed=[], matches=matches.copy(),
               toleranceUs=tolerance)
    if not pending:
        return
    # AVTB gives the verifier an integer timestamp in microseconds.
    expression = "+".join(f"between(pts,{t-tolerance},{t+tolerance})" for t in pending)
    with tempfile.TemporaryDirectory(dir=output) as tmp:
        work = Path(tmp)
        script = work / "select.txt"
        filters = f"settb=AVTB,select='{expression}',showinfo,scale='min(640,iw)':-2"
        # Inline short filters on all versions; avoid Windows command-line limits on long batches.
        if len(filters) <= 24000:
            filter_args = ["-vf", filters]
        else:
            script.write_text(filters, encoding="ascii")
            help_text = subprocess.run([FFMPEG, "-hide_banner", "-h", "full"],
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, encoding="utf-8", errors="replace").stdout
            option = "-filter_script:v" if re.search(r"(?m)^-filter_script\s", help_text) else "-/filter:v"
            filter_args = [option, str(script)]
        end = (pending[-1]+tolerance+1)/1e6
        command = [FFMPEG, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
                   "-t", f"{end:.6f}", "-i", str(video), "-map", "0:v:0", "-an", "-sn",
                   *filter_args, "-fps_mode", "passthrough", "-q:v", "3",
                   str(work / "%08d.jpg")]
        observed, diagnostics = [], []
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace")
        job["process"] = process
        if job["stop"]:
            process.terminate()
        try:
            for line in process.stderr:
                match = PTS.search(line)
                if match:
                    observed.append(int(match[1]))
                    job["decodedCandidates"] = len(observed)
                elif line.strip():
                    diagnostics = (diagnostics + [line.strip()])[-12:]
            code = process.wait()
        finally:
            job.pop("process", None)
            process.stderr.close()
        candidates = sorted((pts, index) for index, pts in enumerate(observed, 1)
                            if (work / f"{index:08d}.jpg").is_file()
                            and (work / f"{index:08d}.jpg").stat().st_size)
        for target in pending:
            position = bisect_left(candidates, (target, 0))
            nearby = candidates[max(0, position-1):position+1]
            if nearby and code == 0 and not job["stop"]:
                actual, index = min(nearby, key=lambda entry: (abs(entry[0]-target), entry))
                if abs(actual-target) <= tolerance:
                    staged = work / "preview.jpg"
                    shutil.copyfile(work / f"{index:08d}.jpg", staged)
                    destination = output / str(target)
                    destination.mkdir(exist_ok=True)
                    staged.replace(destination / f"{actual}.jpg")
                    matches[target] = actual
                    job["processed"] += 1
                    continue
            job["failed"].append(target)
        job["matches"] = matches
        job["diagnostics"] = {"exitCode":code,"lastMessages":diagnostics,"matchedPtsUs":observed}


def run_job(job, video, requests, tolerance):
    try:
        make_previews(job,video,requests,tolerance)
    except Exception as error:
        job["error"] = str(error)
    finally:
        job["done"] = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT/"dist"),**kwargs)

    def authorized(self):
        origin = self.headers.get("Origin")
        return (self.headers.get("X-Track-Lab") == TOKEN
                and self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"
                and origin in (None,f"http://127.0.0.1:{self.server.server_port}"))

    def reply(self,data,status=200,mime="application/json",headers=None):
        body = json.dumps(data,ensure_ascii=False).encode() if mime=="application/json" else data
        self.send_response(status)
        self.send_header("Content-Type",mime)
        self.send_header("Content-Length",str(len(body)))
        self.send_header("Cache-Control","no-store")
        self.send_header("Cross-Origin-Resource-Policy","same-origin")
        for name, value in (headers or {}).items():
            self.send_header(name,value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            return self.send_error(403)
        if self.path == "/local-config.js":
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                return self.send_error(403)
            return self.reply(f"globalThis.trackLabToken={json.dumps(TOKEN)};".encode(),mime="application/javascript")
        if not self.path.startswith("/api/"):
            return super().do_GET()
        if not self.authorized():
            return self.send_error(403)
        parts = self.path.split("/")
        if len(parts)==4 and parts[2]=="jobs" and parts[3] in JOBS:
            return self.reply({k:v for k,v in JOBS[parts[3]].copy().items() if k!="process"})
        if (len(parts)==6 and parts[2]=="image" and ID.fullmatch(parts[3])
                and all(re.fullmatch(r"[0-9]{1,12}", part) for part in parts[4:])):
            tolerance, target = map(int, parts[4:])
            image = cached_preview(CACHE / parts[3] / str(tolerance), target)
            if image:
                return self.reply(image.read_bytes(),mime="image/jpeg",
                                  headers={"X-Preview-PTS-Us":image.stem})
        self.send_error(404)

    def project_file(self, data):
        root = Path(data["root"])
        if not root.is_absolute():
            raise ValueError("需要專案資料夾的完整路徑")
        root = root.resolve(strict=True)
        relative = Path(data["path"])
        if relative.is_absolute() or relative.drive or ".." in relative.parts:
            raise ValueError("需要專案資料夾內的相對路徑")
        file = (root / relative).resolve(strict=True)
        if not file.is_relative_to(root) or not file.is_file():
            raise ValueError("找不到專案資料夾內的檔案")
        if file.suffix.lower() not in {".csv", ".txt", ".json", ".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi"}:
            raise ValueError("不支援的專案檔案類型")
        with file.open("rb") as stream:
            before = os.fstat(stream.fileno())
            if before.st_size != data["size"]:
                raise ValueError("檔案大小與專案不符")
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(4194304), b""):
                digest.update(hashlib.sha256(chunk).digest())
            after = os.fstat(stream.fileno())
            if (before.st_mtime_ns != after.st_mtime_ns
                    or digest.hexdigest() != data["fingerprint"]):
                raise ValueError("檔案內容與專案指紋不符")
            stream.seek(0)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(before.st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.end_headers()
            shutil.copyfileobj(stream, self.wfile, 1024**2)

    def do_POST(self):
        if not self.authorized():
            return self.send_error(403)
        try:
            size = int(self.headers.get("Content-Length","0"))
            if self.path=="/api/video" and 0<size<=128*1024**3:
                digest = hashlib.sha256()
                with tempfile.NamedTemporaryFile(dir=TEMP,delete=False) as stream:
                    incoming = Path(stream.name)
                    try:
                        remaining = size
                        while remaining:
                            data = self.rfile.read(min(1024**2,remaining))
                            if not data:
                                raise ValueError("影片傳輸中斷")
                            stream.write(data)
                            digest.update(data)
                            remaining -= len(data)
                    except Exception:
                        stream.close()
                        incoming.unlink(missing_ok=True)
                        raise
                identity = digest.hexdigest()
                video = Path(TEMP)/identity
                if video.exists():
                    incoming.unlink()
                else:
                    incoming.replace(video)
                VIDEOS[identity] = video
                return self.reply({"id":identity})
            if not 0<size<=512_000:
                raise ValueError("請求大小不符")
            data = json.loads(self.rfile.read(size))
            if self.path=="/api/project-file":
                return self.project_file(data)
            if self.path=="/api/jobs":
                if not FFMPEG:
                    raise ValueError("找不到 FFmpeg。請將 ffmpeg.exe 放在 bin 或加入 PATH。")
                video = VIDEOS.get(data["video"])
                targets = data["targets"]
                if video is None or not 0<len(targets)<=10000 or any(
                        type(t) is not int or not 0<=t<=86400_000000 for t in targets):
                    raise ValueError("影片或目標時間無效")
                tolerance = data.get("toleranceUs", 25000)
                if type(tolerance) is not int or not 1000 <= tolerance <= 250000:
                    raise ValueError("預覽容許誤差須為 1–250 ms")
                identity = secrets.token_hex(16)
                job = JOBS[identity] = {"done":False,"stop":False,"processed":0}
                threading.Thread(target=run_job,args=(job,video,sorted(set(targets)),tolerance),daemon=True).start()
                return self.reply({"id":identity})
            if self.path=="/api/cancel" and data["id"] in JOBS:
                job = JOBS[data["id"]]
                job["stop"] = True
                process = job.get("process")
                if process and process.poll() is None:
                    process.terminate()
                return self.reply({"ok":True})
            self.send_error(404)
        except (BrokenPipeError,ConnectionResetError):
            return
        except (ValueError,KeyError,TypeError,OSError) as error:
            self.reply({"error":str(error)},400)


def main():
    global FFMPEG,TEMP
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",type=int,default=8765)
    parser.add_argument("--no-browser",action="store_true")
    args = parser.parse_args()
    local = ROOT / "bin" / ("ffmpeg.exe" if os.name=="nt" else "ffmpeg")
    FFMPEG = str(local) if local.is_file() else shutil.which("ffmpeg")
    with tempfile.TemporaryDirectory(prefix="track-lab-") as temp:
        TEMP = temp
        with ThreadingHTTPServer(("127.0.0.1",args.port),Handler) as server:
            url = f"http://127.0.0.1:{server.server_port}/"
            print(f"Track Lab: {url}\nFFmpeg: {FFMPEG or 'not found'}",flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                for job in JOBS.values():
                    job["stop"] = True
                    if process := job.get("process"):
                        process.terminate()


if __name__=="__main__":
    main()
