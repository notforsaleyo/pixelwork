/**
 * PixelWork Inspector Controller.
 * Features:
 * - Pre-loads ALL frames into in-memory canvases at atlas load time (instant, zero-latency playback & track switching)
 * - Loading overlay during atlas fetch & processing
 * - Instant frame & preview rendering when selecting tracks even while paused
 * - Spacebar and Arrow key controls without losing focus to buttons/sliders
 * - Direct scale input (1 to 32)
 * - Clear selection on ESC or track switch
 * - File picker for easy image selection & upload
 */

let project = null;
let loadedTracks = []; // In-memory pre-sliced frames: loadedTracks[trackIdx].frames[frameIdx].canvas
let currentTrackIndex = 0;
let currentFrameIndex = 0;
let isPlaying = true;
let animTimer = null;
let frameDelayMs = 120; // Default 120ms

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
const scaleInput = document.getElementById("scale-input");
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

const filePicker = document.getElementById("file-picker");
const btnFilePick = document.getElementById("btn-file-pick");
const fileNameDisp = document.getElementById("file-name-disp");

const loadingOverlay = document.getElementById("loading-overlay");
const loadingText = document.getElementById("loading-text");

function showLoading(msg) {
  loadingText.textContent = msg || "로딩 중...";
  loadingOverlay.style.display = "flex";
}

function hideLoading() {
  loadingOverlay.style.display = "none";
}

// Blur buttons after click so Spacebar doesn't trigger button clicks
document.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    btn.blur();
  });
});

// --- 1. Keyboard Shortcuts (Arrow Left/Right, Spacebar, ESC) ---
window.addEventListener("keydown", (e) => {
  const active = document.activeElement;
  const isTextInput = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && (active.type === "text" || active.type === "number")));

  // ESC: Always clears selection
  if (e.code === "Escape") {
    e.preventDefault();
    clearSelection();
    if (active) active.blur();
    return;
  }

  // If typing inside an input/textarea, let normal typing happen
  if (isTextInput) {
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (active) active.blur();
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
  if (isPlaying) {
    startAnimation();
  } else {
    clearInterval(animTimer);
  }
}

btnPlay.addEventListener("click", togglePlayPause);
btnPrev.addEventListener("click", () => stepFrame(-1));
btnNext.addEventListener("click", () => stepFrame(1));

// --- 2. Frame Delay Controls (ms) ---
delayInput.addEventListener("input", (e) => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 10) val = 10;
  frameDelayMs = val;
  if (isPlaying) startAnimation();
});

// --- 3. Zoom Scale Input (1 to 32) ---
scaleInput.addEventListener("input", (e) => {
  let val = parseInt(e.target.value, 10);
  if (isNaN(val) || val < 1) val = 1;
  if (val > 32) val = 32;
  canvasScale = val;
  if (project) {
    editorCanvas.width = project.frame_width * canvasScale;
    editorCanvas.height = project.frame_height * canvasScale;
    renderCurrentFrame();
  }
});

onionToggle.addEventListener("change", renderCurrentFrame);
gridToggle.addEventListener("change", renderCurrentFrame);

document.getElementById("btn-clear-selection").addEventListener("click", clearSelection);

function clearSelection() {
  selectedBBox = null;
  bboxCoords.textContent = "마우스로 어색한 부위를 드래그하세요";
  taskBBoxDisp.textContent = "영역 미선택";
  renderCurrentFrame();
}

// --- 4. File Picker & Upload Handler ---
btnFilePick.addEventListener("click", () => {
  filePicker.click();
});

filePicker.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const fw = parseInt(document.getElementById("input-fw").value, 10) || 24;
  const fh = parseInt(document.getElementById("input-fh").value, 10) || 32;

  showLoading("파일 업로드 및 슬라이싱 중...");
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "X-Filename": encodeURIComponent(file.name),
        "X-Frame-Width": fw,
        "X-Frame-Height": fh
      },
      body: file
    });
    const data = await res.json();
    if (data.status === "ok") {
      fileNameDisp.textContent = data.file_path;
      fileNameDisp.title = data.file_path;
      showStatus("업로드 완료!", "#34a853");
      await loadProjectAndAllFrames(false);
    } else {
      hideLoading();
      showStatus("에러: " + data.message, "#d93025");
    }
  } catch (err) {
    hideLoading();
    showStatus("업로드 실패: " + err, "#d93025");
  }
});

// --- 5. On-Demand Reload Atlas Button ---
document.getElementById("btn-slice").addEventListener("click", async () => {
  const image_path = fileNameDisp.textContent.trim() || "src/len_atlas.png";
  const frame_w = parseInt(document.getElementById("input-fw").value, 10) || 24;
  const frame_h = parseInt(document.getElementById("input-fh").value, 10) || 32;
  
  showLoading("아틀라스를 읽고 전체 프레임을 메모리에 로드하는 중...");
  try {
    const res = await fetch("/api/slice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_path, frame_width: frame_w, frame_height: frame_h })
    });
    const data = await res.json();
    if (data.status === "ok") {
      await loadProjectAndAllFrames(true);
      showStatus("아틀라스 동기화 완료!", "#34a853");
    } else {
      hideLoading();
      showStatus("에러: " + data.message, "#d93025");
    }
  } catch (err) {
    hideLoading();
    showStatus("요청 실패: " + err, "#d93025");
  }
});

// --- 6. AI Task Dispatch ---
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
  
  const curTrack = loadedTracks[currentTrackIndex];
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

      patchInstruction.value = "";
      clearSelection();
    } else {
      alert("작업 전송 실패: " + data.message);
    }
  } catch (err) {
    alert("요청 에러: " + err);
  } finally {
    btnSendTask.disabled = false;
  }
});

// --- 7. In-Memory Preloader & Track Management ---
async function loadProjectAndAllFrames(preserveSelection = false) {
  showLoading("아틀라스 이미지 및 메타데이터 로딩 중...");
  try {
    // 1. Fetch metadata
    const metaRes = await fetch("/api/project?t=" + Date.now());
    if (!metaRes.ok) throw new Error("Metadata not found");
    project = await metaRes.json();

    // 2. Fetch full atlas image
    const atlasImg = await loadImage("/api/atlas?t=" + Date.now());

    // 3. Pre-slice ALL frames into in-memory canvases
    const fw = project.frame_width;
    const fh = project.frame_height;
    loadedTracks = [];

    project.tracks.forEach(tMeta => {
      const row = tMeta.id;
      const trackObj = {
        id: row,
        name: tMeta.name,
        frame_count: tMeta.frame_count,
        frames: []
      };

      tMeta.frames.forEach(fMeta => {
        const col = fMeta.index;
        const offCanvas = document.createElement("canvas");
        offCanvas.width = fw;
        offCanvas.height = fh;
        const oCtx = offCanvas.getContext("2d");
        oCtx.imageSmoothingEnabled = false;
        // Slice directly from atlasImg
        oCtx.drawImage(
          atlasImg,
          col * fw, row * fh, fw, fh, // source rect
          0, 0, fw, fh                // dest rect
        );

        trackObj.frames.push({
          index: col,
          file: fMeta.file,
          canvas: offCanvas
        });
      });

      loadedTracks.push(trackObj);
    });

    // 4. Update UI dimensions
    document.getElementById("input-fw").value = fw;
    document.getElementById("input-fh").value = fh;

    framePixelCanvas.width = fw;
    framePixelCanvas.height = fh;

    const scaleVal = parseInt(scaleInput.value, 10);
    if (!isNaN(scaleVal) && scaleVal >= 1 && scaleVal <= 32) {
      canvasScale = scaleVal;
    }

    editorCanvas.width = fw * canvasScale;
    editorCanvas.height = fh * canvasScale;

    animCanvas.width = fw * 4;
    animCanvas.height = fh * 4;

    // 5. Populate Track Selector
    const prevTrack = currentTrackIndex;
    trackSelect.innerHTML = "";
    loadedTracks.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = idx;
      opt.textContent = `${t.name} (${t.frame_count} frames)`;
      trackSelect.appendChild(opt);
    });

    if (preserveSelection && loadedTracks[prevTrack]) {
      currentTrackIndex = prevTrack;
    } else {
      currentTrackIndex = 0;
    }
    trackSelect.selectedIndex = currentTrackIndex;

    hideLoading();

    // 6. Instantly render the selected track!
    selectTrack(currentTrackIndex, preserveSelection);
  } catch (err) {
    hideLoading();
    console.error("Error preloading atlas:", err);
    showStatus("로딩 에러: " + err, "#d93025");
  }
}

// Track selection handlers (instant response!)
trackSelect.addEventListener("change", (e) => {
  selectTrack(parseInt(e.target.value, 10), false);
  trackSelect.blur();
});

function selectTrack(trackIdx, preserveFrame = false) {
  if (!loadedTracks || loadedTracks.length === 0) return;
  currentTrackIndex = trackIdx;
  if (!preserveFrame) {
    currentFrameIndex = 0;
  }
  clearSelection();

  // Instant synchronous render of the first frame!
  renderCurrentFrame();

  if (isPlaying) {
    startAnimation();
  } else {
    clearInterval(animTimer);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image: " + src));
    img.src = src;
  });
}

function stepFrame(delta) {
  if (!loadedTracks || !loadedTracks[currentTrackIndex]) return;
  const curTrack = loadedTracks[currentTrackIndex];
  if (curTrack.frame_count === 0) return;
  currentFrameIndex = (currentFrameIndex + delta + curTrack.frame_count) % curTrack.frame_count;
  renderCurrentFrame();
}

function startAnimation() {
  clearInterval(animTimer);
  if (!isPlaying) return;
  animTimer = setInterval(() => {
    stepFrame(1);
  }, frameDelayMs);
}

// --- 8. Instant Synchronous Canvas Rendering (0ms) ---
function renderCurrentFrame() {
  if (!loadedTracks || !loadedTracks[currentTrackIndex]) return;
  const curTrack = loadedTracks[currentTrackIndex];
  if (!curTrack.frames || curTrack.frames.length === 0) return;

  const curFrame = curTrack.frames[currentFrameIndex];
  if (!curFrame) return;

  const fw = project.frame_width;
  const fh = project.frame_height;

  // Update text labels
  curFrameName.textContent = `${curTrack.name} [${currentFrameIndex + 1} / ${curTrack.frame_count}]`;
  frameIndicator.textContent = `${currentFrameIndex + 1} / ${curTrack.frame_count}`;

  // Get previous frame for onion skinning
  const prevIdx = (currentFrameIndex - 1 + curTrack.frame_count) % curTrack.frame_count;
  const prevFrame = curTrack.frames[prevIdx];

  // 1. Render Animation Preview Canvas
  animCtx.clearRect(0, 0, animCanvas.width, animCanvas.height);
  animCtx.imageSmoothingEnabled = false;

  if (onionToggle.checked && prevFrame && prevFrame.canvas) {
    animCtx.globalAlpha = 0.35;
    animCtx.drawImage(prevFrame.canvas, 0, 0, animCanvas.width, animCanvas.height);
    animCtx.globalAlpha = 1.0;
  }
  if (curFrame.canvas) {
    animCtx.drawImage(curFrame.canvas, 0, 0, animCanvas.width, animCanvas.height);
  }

  // 2. Render Main Editor Canvas
  editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  editorCtx.imageSmoothingEnabled = false;

  // Onion skin underneath
  if (onionToggle.checked && prevFrame && prevFrame.canvas) {
    editorCtx.globalAlpha = 0.28;
    editorCtx.drawImage(prevFrame.canvas, 0, 0, editorCanvas.width, editorCanvas.height);
    editorCtx.globalAlpha = 1.0;
  }

  // Draw current frame scaled
  if (curFrame.canvas) {
    editorCtx.drawImage(curFrame.canvas, 0, 0, editorCanvas.width, editorCanvas.height);
  }

  // Pixel Grid Overlay
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

  // Selection Bounding Box Highlight
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
  renderCurrentFrame();
});

window.addEventListener("mouseup", () => {
  isMouseDown = false;
});

function showStatus(text, color = "#1a73e8") {
  statusMsg.textContent = text;
  statusMsg.style.color = color;
  setTimeout(() => {
    statusMsg.textContent = "";
  }, 4000);
}

// Initial Boot: Preload all frames into RAM
loadProjectAndAllFrames();
