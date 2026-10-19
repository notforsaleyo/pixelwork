"""
Task Manager for PixelWork.
Allows viewing active task and marking it as completed (deletes task and triggers UI update).
"""
import os
import sys
import json
import urllib.request

TASK_FILE = "data/task_request.json"

def get_current_task():
    if not os.path.exists(TASK_FILE):
        return None
    try:
        with open(TASK_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def complete_task(message="작업 완료"):
    # Delete task files
    removed = []
    for f in [TASK_FILE, "data/task_context.png", "data/task_micro.png"]:
        if os.path.exists(f):
            try:
                os.remove(f)
                removed.append(f)
            except Exception as e:
                print(f"Error removing {f}: {e}")

    # Notify server to increment version and re-slice
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8088/api/task/complete",
            data=json.dumps({"message": message}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Task completed successfully! Server version bumped to {data.get('version')}.")
    except Exception as e:
        print(f"Task files deleted ({removed}). (Server notification note: {e})")

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "get"
    if action == "get":
        task = get_current_task()
        if task:
            print(json.dumps(task, indent=2, ensure_ascii=False))
        else:
            print("No active task.")
    elif action == "complete":
        msg = sys.argv[2] if len(sys.argv) > 2 else "작업 완료"
        complete_task(msg)
