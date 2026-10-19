"""
PixelWork Local Web Studio Backend.
Features:
- Dynamic Slicing & File Upload: users can pick or upload any atlas image
- On-demand Reload: slices and refreshes when requested by the user
- Task Dispatch & Completion: saves tasks, deletes upon completion, bumps project version for UI update
"""
import os
import sys
import json
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

from tools.slicer import slice_spritesheet, pack_spritesheet
from tools.patch_engine import create_inspection_views, apply_pixel_matrix_to_atlas

PORT = 8088

PROJECT_STATE = {
    "source_image": "src/len_atlas.png",
    "frame_width": 24,
    "frame_height": 32,
    "version": 1
}

class PixelStudioHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Disable caching for live pixel updates
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/":
            self.serve_file("web/index.html", "text/html; charset=utf-8")
        elif path == "/style.css":
            self.serve_file("web/style.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self.serve_file("web/app.js", "application/javascript; charset=utf-8")
            
        elif path == "/api/project":
            self.send_json_file("data/metadata.json")

        elif path == "/api/version":
            has_task = os.path.exists("data/task_request.json")
            self.send_json({
                "version": PROJECT_STATE["version"],
                "has_task": has_task
            })

        elif path == "/api/atlas":
            src = PROJECT_STATE["source_image"]
            if os.path.exists(src):
                self.serve_file(src, "image/png")
            else:
                self.send_error(404, "Atlas not found")

        elif path == "/api/frame":
            frame_file = query.get("file", [None])[0]
            if frame_file:
                safe_name = os.path.basename(frame_file)
                full_path = os.path.join("data/frames", safe_name)
                if os.path.exists(full_path):
                    self.serve_file(full_path, "image/png")
                    return
            self.send_error(404, "Frame not found")

        elif path.startswith("/data/"):
            clean_path = path.lstrip("/")
            if os.path.exists(clean_path):
                ext = clean_path.split(".")[-1].lower()
                mime = "image/png" if ext == "png" else "application/octet-stream"
                self.serve_file(clean_path, mime)
            else:
                self.send_error(404, "File not found")
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        content_len = int(self.headers.get("Content-Length", 0))

        if path == "/api/upload":
            raw_filename = self.headers.get("X-Filename", "uploaded_atlas.png")
            safe_name = os.path.basename(urllib.parse.unquote(raw_filename))
            if not safe_name:
                safe_name = "uploaded_atlas.png"
            target_path = os.path.join("src", safe_name)
            os.makedirs("src", exist_ok=True)

            file_bytes = self.rfile.read(content_len)
            with open(target_path, "wb") as f:
                f.write(file_bytes)

            fw = int(self.headers.get("X-Frame-Width", PROJECT_STATE["frame_width"]))
            fh = int(self.headers.get("X-Frame-Height", PROJECT_STATE["frame_height"]))

            PROJECT_STATE["source_image"] = target_path.replace("\\", "/")
            PROJECT_STATE["frame_width"] = fw
            PROJECT_STATE["frame_height"] = fh
            PROJECT_STATE["version"] += 1

            try:
                meta = slice_spritesheet(target_path, frame_w=fw, frame_h=fh)
                self.send_json({"status": "ok", "file_path": target_path.replace("\\", "/"), "metadata": meta, "version": PROJECT_STATE["version"]})
            except Exception as e:
                self.send_json({"status": "error", "message": str(e)}, status=500)
            return

        post_data = self.rfile.read(content_len).decode("utf-8") if content_len > 0 else "{}"
        try:
            body = json.loads(post_data)
        except Exception:
            body = {}

        if path == "/api/slice":
            img_path = body.get("image_path", PROJECT_STATE["source_image"])
            fw = int(body.get("frame_width", PROJECT_STATE["frame_width"]))
            fh = int(body.get("frame_height", PROJECT_STATE["frame_height"]))
            
            PROJECT_STATE["source_image"] = img_path
            PROJECT_STATE["frame_width"] = fw
            PROJECT_STATE["frame_height"] = fh
            PROJECT_STATE["version"] += 1
            
            try:
                meta = slice_spritesheet(img_path, frame_w=fw, frame_h=fh)
                self.send_json({"status": "ok", "metadata": meta, "version": PROJECT_STATE["version"]})
            except Exception as e:
                self.send_json({"status": "error", "message": str(e)}, status=500)

        elif path == "/api/task":
            track_id = body.get("track_id")
            track_name = body.get("track_name", "")
            frame_index = body.get("frame_index")
            frame_file = body.get("frame_file")
            bbox = body.get("bbox")
            instruction = body.get("instruction", "").strip()

            if frame_file is None or bbox is None or not instruction:
                self.send_json({"status": "error", "message": "Missing required fields"}, status=400)
                return

            frame_path = os.path.join("data/frames", os.path.basename(frame_file))
            try:
                inspect_views = create_inspection_views(frame_path, bbox, output_prefix="data/task")
                task_data = {
                    "source_image": PROJECT_STATE["source_image"],
                    "frame_width": PROJECT_STATE["frame_width"],
                    "frame_height": PROJECT_STATE["frame_height"],
                    "track_id": track_id,
                    "track_name": track_name,
                    "frame_index": frame_index,
                    "frame_file": frame_file,
                    "bbox": bbox,
                    "instruction": instruction,
                    "inspect_views": inspect_views,
                    "status": "pending_ai_review"
                }
                with open("data/task_request.json", "w", encoding="utf-8") as f:
                    json.dump(task_data, f, indent=2, ensure_ascii=False)

                self.send_json({"status": "ok", "task": task_data})
            except Exception as e:
                self.send_json({"status": "error", "message": str(e)}, status=500)

        elif path == "/api/task/complete":
            # Deletes task request and temporary inspection views, bumps version instantly
            for f in ["data/task_request.json", "data/task_context.png", "data/task_micro.png"]:
                if os.path.exists(f):
                    try:
                        os.remove(f)
                    except Exception:
                        pass
            PROJECT_STATE["version"] += 1
            self.send_json({"status": "ok", "version": PROJECT_STATE["version"]})
        else:
            self.send_error(404, "Endpoint not found")

    def serve_file(self, file_path, content_type):
        if not os.path.exists(file_path):
            self.send_error(404, "Not found")
            return
        with open(file_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, data, status=200):
        dumped = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dumped)))
        self.end_headers()
        self.wfile.write(dumped)

    def send_json_file(self, file_path):
        if not os.path.exists(file_path):
            self.send_json({"error": "File not found"}, status=404)
            return
        self.serve_file(file_path, "application/json; charset=utf-8")

def run(port=PORT):
    if os.path.exists(PROJECT_STATE["source_image"]):
        slice_spritesheet(
            PROJECT_STATE["source_image"],
            frame_w=PROJECT_STATE["frame_width"],
            frame_h=PROJECT_STATE["frame_height"]
        )
    server = HTTPServer(("127.0.0.1", port), PixelStudioHandler)
    print(f"PixelWork Studio running at http://127.0.0.1:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        server.server_close()

if __name__ == "__main__":
    p = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run(p)
