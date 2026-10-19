/**
 * PixelWork Inspector Controller.
 * Features:
 * - Hot Reloading: polls server for file mtime changes from Aseprite/Photoshop
 * - Animation player with millisecond (ms) delay per frame
 * - Keyboard shortcuts: Arrow keys (Left/Right) for frame scrubbing, Spacebar for Play/Pause
 * - Bounding box region selection & AI Task dispatch with 16x inspection views
 */

let project = null;
let currentTrackIndex = 0;
let currentFrameIndex = 0;
let isPlaying = true;
let animTimer = null;
let frameDelayMs = 120; // Default 120ms

let currentFrameImg = null;
let prevFrameImg = null;
let lastKnownMtime = 0;

// Editor Canvas State
let canvasScale = 16;
let selectedBBox = null; // [x1, y1, x2, y2]
let isMouseDown = false;
let dragStart = null;

// Offscreen 1:1 pixel canvas
const framePixelCanvas = document.createElement("canvas");
const frameCtx = framePixelCanvas.getContext("2d", { willReadFrequently: true });

const editorCanvas = document.getElementById("editor-canvas");
const editorCtx = editorCanvas.getContext("2d");
const animCanvas = document.getElementById("anim-canvas");
const animCtx = animCanvas.getContext("2d");

// DOM Elements
const trackSelect = document.getElementById("track-select");
const btnPlay = document.getElementById("btn-play");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const frameIndicator = document.getElementById("frame-indicator");
const delayInput = document.getElementById("delay-input");
const delaySlider = document.getElementById("delay-slider");
const onionToggle = document.getElementById("onion-toggle");
const gridToggle = document.getElementById("grid-toggle");
const curFrameName = document.getElementById("cur-frame-name");
const bboxCoords = document.getElementById("bbox-coords");
const taskBBoxDisp = document.getElementById("task-bbox-disp");
const patchInstruction = document.getElementById("patch-instruction");
const btnSendTask = document.getElementById("btn-send-task");
const taskNotice = document.getElementById("task-notice");
const inspectSection = document.getElementById("inspect-section");
const inspectContextImg = document.getElementById("inspect-context-img");
const inspectMicroImg = document.getElementById("inspect-micro-img");
const statusMsg = document.getElementById("status-msg");

// --- 1. Keyboard Shortcuts (Arrow Left/Right, Spacebar) ---
window.addEventListener("keydown", (e) => {
  // If user is typing in an input or textarea, ignore shortcuts
  const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    togglePlayPause();
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    stepFrame(-1);
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    stepFrame(1);
  }
});

function togglePlayPause() {
  isPlaying = !isPlaying;
  btnPlay.textContent = isPlaying ? "⏸ 정지 [Space]" : "▶ 재생 [Space]";
  if (isPlaying) startAnimation();
  else clearInterval(animTimer);
}

btnPlay.addEventListener("click", togglePlayPause);
btnPrev.addEventListener("click", () => stepFrame(-1));
btnNext.addEventListener("click", () => stepFrame(1));

// --- 2. Frame Delay Controls (ms) ---
delayInput.addEventListener("input", (e) => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 10) val = 10;
  frameDelayMs = val;
  delaySlider.value = val;
  if (isPlaying) startAnimation();
});

delaySlider.addEventListener("input", (e) => {
  frameDelayMs = parseInt(e.target.value, 10);
  delayInput.value = frameDelayMs;
  if (isPlaying) startAnimation();
});

onionToggle.addEventListener("change", renderEditor);
gridToggle.addEventListener("change", renderEditor);

const scaleSelect = document.getElementById("scale-select");
scaleSelect.addEventListener("change", (e) => {
  canvasScale = parseInt(e.target.value, 10);
  if (project) {
    editorCanvas.width = project.frame_width * canvasScale;
    editorCanvas.height = project.frame_height * canvasScale;
    renderEditor();
  }
});

document.getElementById("btn-clear-selection").addEventListener("click", () => {
  selectedBBox = null;
  bboxCoords.textContent = "마우스로 어색한 부위를 드래그하세요";
  taskBBoxDisp.textContent = "영역 미선택";
  renderEditor();
});

// --- 3. Reload Atlas Button ---
document.getElementById("btn-slice").addEventListener("click", async () => {
  const image_path = document.getElementById("input-source").value.trim();
  const frame_w = parseInt(document.getElementById("input-fw").value, 10);
  const frame_h = parseInt(document.getElementById("input-fh").value, 10);
  
  showStatus("아틀라스 읽는 중...", "#1a73e8");
  try {
    const res = await fetch("/api/slice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path, frame_width: frame_w, frame_height: frame_h })
    });
    const data = await res.json();
    if (data.status === "ok") {
      showStatus("아틀라스 동기화 완료!", "#34a853");
      await loadProject(true);
    } else {
      showStatus("에러: " + data.message, "#d93025");
    }
  } catch (err) {
    showStatus("요청 실패: " + err, "#d93025");
  }
});

// --- 4. AI Task Dispatch ---
btnSendTask.addEventListener("click", async () => {
  if (!selectedBBox) {
    alert("캔버스에서 어색한 부위를 먼저 마우스로 드래그하여 선택하세요.");
    return;
  }
  const instruction = patchInstruction.value.trim();
  if (!instruction) {
    alert("어색한 부분과 어떻게 고쳐야 할지 지시사항을 입력해주세요.");
    patchInstruction.focus();
    return;
  }
  
  const curTrack = project.tracks[currentTrackIndex];
  const curFrame = curTrack.frames[currentFrameIndex];

  showStatus("AI 작업 전송 중...", "#1a73e8");
  btnSendTask.disabled = true;

  try {
    const res = await fetch("/api/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_id: curTrack.id,
        track_name: curTrack.name,
        frame_index: currentFrameIndex,
        frame_file: curFrame.file,
        bbox: selectedBBox,
        instruction: instruction
      })
    });
    const data = await res.json();
    if (data.status === "ok") {
      showStatus("AI 작업 요청 저장 완료!", "#34a853");
      
      // Show inspect images
      inspectSection.style.display = "block";
      inspectContextImg.src = "/" + data.task.inspect_views.context_image + "?t=" + Date.now();
      inspectMicroImg.src = "/" + data.task.inspect_views.micro_image + "?t=" + Date.now();

      taskNotice.style.display = "block";
      taskNotice.innerHTML = `
        <strong>✅ AI 작업 등록 완료!</strong><br>
        <strong>대상</strong>: ${curTrack.name} - 프레임 ${currentFrameIndex + 1}<br>
        <strong>영역</strong>: X(${selectedBBox[0]}~${selectedBBox[1]}), Y(${selectedBBox[2]}~${selectedBBox[3]})<br>
        채팅창에서 <strong>"방금 보낸 작업 진행해줘"</strong>라고 말씀하시면 즉시 수정을 진행합니다.
      `;
    } else {
      alert("작업 전송 실패: " + data.message);
    }
  } catch (err) {
    alert("요청 에러: " + err);
  } finally {
    btnSendTask.disabled = false;
  }
});

// --- 5. Project Loader & Frame Management ---
async function loadProject(preserveSelection = false) {
  try {
    const res = await fetch("/api/project");
    if (!res.ok) return;
    project = await res.json();
    
    document.getElementById("input-fw").value = project.frame_width;
    document.getElementById("input-fh").value = project.frame_height;

    framePixelCanvas.width = project.frame_width;
    framePixelCanvas.height = project.frame_height;

    const scaleVal = document.getElementById("scale-select");
    if (scaleVal) canvasScale = parseInt(scaleVal.value, 10) || 16;

    editorCanvas.width = project.frame_width * canvasScale;
    editorCanvas.height = project.frame_height * canvasScale;

    animCanvas.width = project.frame_width * 4;
    animCanvas.height = project.frame_height * 4;

    const prevTrack = currentTrackIndex;
    trackSelect.innerHTML = "";
    project.tracks.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      opt.textContent = `${t.name} (${t.frame_count} frames)`;
      trackSelect.appendChild(opt);
    });

    if (preserveSelection && project.tracks[prevTrack]) {
      currentTrackIndex = prevTrack;
    } else {
      currentTrackIndex = 0;
    }
    trackSelect.selectedIndex = currentTrackIndex;

    selectTrack(currentTrackIndex, preserveSelection);
  } catch (err) {
    console.error("Error loading project:", err);
  }
}

trackSelect.addEventListener("change", (e) => {
  selectTrack(parseInt(e.target.value, 10), false);
});

function selectTrack(trackIdx, preserveFrame = false) {
  currentTrackIndex = trackIdx;
  if (!preserveFrame) {
    currentFrameIndex = 0;
  }
  startAnimation();
  loadFrame(currentFrameIndex);
}

async function loadFrame(index, forceReload = true) {
  if (!project || !project.tracks[currentTrackIndex]) return;
  const curTrack = project.tracks[currentTrackIndex];
  if (!curTrack.frames || curTrack.frames.length === 0) return;

  currentFrameIndex = index % curTrack.frames.length;
  const frameInfo = curTrack.frames[currentFrameIndex];
  curFrameName.textContent = `${curTrack.name} [${currentFrameIndex + 1} / ${curTrack.frame_count}]`;
  frameIndicator.textContent = `${currentFrameIndex + 1} / ${curTrack.frame_count}`;

  const cacheBuster = forceReload ? `?t=${Date.now()}` : "";
  const curUrl = `/api/frame?file=${frameInfo.file}${cacheBuster}`;
  currentFrameImg = await loadImage(curUrl);

  // Previous frame for onion skin
  const prevIdx = (currentFrameIndex - 1 + curTrack.frame_count) % curTrack.frame_count;
  const prevFrameInfo = curTrack.frames[prevIdx];
  const prevUrl = `/api/frame?file=${prevFrameInfo.file}${cacheBuster}`;
  prevFrameImg = await loadImage(prevUrl);

  frameCtx.clearRect(0, 0, framePixelCanvas.width, framePixelCanvas.height);
  frameCtx.drawImage(currentFrameImg, 0, 0);

  renderEditor();
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(img);
    img.src = src;
  });
}

function stepFrame(delta) {
  if (!project || !project.tracks[currentTrackIndex]) return;
  const curTrack = project.tracks[currentTrackIndex];
  if (curTrack.frame_count === 0) return;
  const nextIdx = (currentFrameIndex + delta + curTrack.frame_count) % curTrack.frame_count;
  loadFrame(nextIdx, false);
}

function startAnimation() {
  clearInterval(animTimer);
  if (!isPlaying) return;
  animTimer = setInterval(() => {
    stepFrame(1);
  }, frameDelayMs);
}

// --- 6. Editor Rendering & Box Selection ---
function renderEditor() {
  if (!project) return;
  const fw = project.frame_width;
  const fh = project.frame_height;

  // 1. Animation Preview
  animCtx.clearRect(0, 0, animCanvas.width, animCanvas.height);
  animCtx.imageSmoothingEnabled = false;
  if (onionToggle.checked && prevFrameImg) {
    animCtx.globalAlpha = 0.35;
    animCtx.drawImage(prevFrameImg, 0, 0, animCanvas.width, animCanvas.height);
    animCtx.globalAlpha = 1.0;
  }
  if (currentFrameImg) {
    animCtx.drawImage(currentFrameImg, 0, 0, animCanvas.width, animCanvas.height);
  }

  // 2. Editor Canvas
  editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  editorCtx.imageSmoothingEnabled = false;

  // Onion skin underneath
  if (onionToggle.checked && prevFrameImg) {
    editorCtx.globalAlpha = 0.3;
    editorCtx.drawImage(prevFrameImg, 0, 0, editorCanvas.width, editorCanvas.height);
    editorCtx.globalAlpha = 1.0;
  }

  // Current frame pixels
  editorCtx.drawImage(framePixelCanvas, 0, 0, editorCanvas.width, editorCanvas.height);

  // Pixel Grid Overlay (Fine light lines)
  if (gridToggle.checked) {
    editorCtx.strokeStyle = "rgba(0, 0, 0, 0.12)";
    editorCtx.lineWidth = 1;
    for (let x = 0; x <= fw; x++) {
      editorCtx.beginPath();
      editorCtx.moveTo(x * canvasScale, 0);
      editorCtx.lineTo(x * canvasScale, fh * canvasScale);
      editorCtx.stroke();
    }
    for (let y = 0; y <= fh; y++) {
      editorCtx.beginPath();
      editorCtx.moveTo(0, y * canvasScale);
      editorCtx.lineTo(fw * canvasScale, y * canvasScale);
      editorCtx.stroke();
    }
  }

  // Selection Bounding Box Highlight (Bold Red)
  if (selectedBBox) {
    const [x1, y1, x2, y2] = selectedBBox;
    editorCtx.strokeStyle = "#d93025";
    editorCtx.lineWidth = 2;
    editorCtx.strokeRect(
      x1 * canvasScale,
      y1 * canvasScale,
      (x2 - x1) * canvasScale,
      (y2 - y1) * canvasScale
    );
    editorCtx.fillStyle = "rgba(217, 48, 37, 0.18)";
    editorCtx.fillRect(
      x1 * canvasScale,
      y1 * canvasScale,
      (x2 - x1) * canvasScale,
      (y2 - y1) * canvasScale
    );
  }
}

// Mouse Drag Selection
editorCanvas.addEventListener("mousedown", (e) => {
  isMouseDown = true;
  const rect = editorCanvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) / canvasScale);
  const py = Math.floor((e.clientY - rect.top) / canvasScale);
  dragStart = { x: px, y: py };
});

window.addEventListener("mousemove", (e) => {
  if (!isMouseDown || !project || !dragStart) return;
  const rect = editorCanvas.getBoundingClientRect();
  const px = Math.floor((e.clientX - rect.left) / canvasScale);
  const py = Math.floor((e.clientY - rect.top) / canvasScale);

  const clampedX = Math.max(0, Math.min(px, project.frame_width - 1));
  const clampedY = Math.max(0, Math.min(py, project.frame_height - 1));

  const x1 = Math.min(dragStart.x, clampedX);
  const y1 = Math.min(dragStart.y, clampedY);
  const x2 = Math.max(dragStart.x, clampedX) + 1;
  const y2 = Math.max(dragStart.y, clampedY) + 1;

  selectedBBox = [x1, y1, x2, y2];
  const coordStr = `X: ${x1}~${x2}, Y: ${y1}~${y2} (${x2 - x1}×${y2 - y1} px)`;
  bboxCoords.textContent = coordStr;
  taskBBoxDisp.textContent = coordStr;
  renderEditor();
});

window.addEventListener("mouseup", () => {
  isMouseDown = false;
});

// --- 7. Hot Reload Poller (Every 800ms) ---
setInterval(async () => {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.mtime && data.mtime !== lastKnownMtime) {
      if (lastKnownMtime !== 0) {
        showStatus("⚡ 외부 수정 감지! 아틀라스 갱신됨", "#1a73e8");
        await loadProject(true);
      }
      lastKnownMtime = data.mtime;
    }
  } catch (e) {
    // server momentarily offline or restarting
  }
}, 800);

function showStatus(text, color = "#1a73e8") {
  statusMsg.textContent = text;
  statusMsg.style.color = color;
  setTimeout(() => {
    statusMsg.textContent = "";
  }, 4000);
}

// Initial Boot
loadProject();
