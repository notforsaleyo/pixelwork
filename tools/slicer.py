"""
Dynamic Sprite Sheet & Atlas Manager.
Supports arbitrary image dimensions, configurable frame widths/heights,
and dynamic project handling (no hardcoded resolutions or counts).
"""
import os
import json
import math
from PIL import Image

def slice_spritesheet(image_path, frame_w=24, frame_h=32, output_dir="data/frames"):
    """
    Slices any spritesheet dynamically based on provided frame dimensions.
    """
    os.makedirs(output_dir, exist_ok=True)
    img = Image.open(image_path).convert("RGBA")
    img_w, img_h = img.size
    
    frame_w = int(frame_w)
    frame_h = int(frame_h)
    
    cols = max(1, img_w // frame_w)
    rows = max(1, img_h // frame_h)
    
    tracks = []
    palette_set = set()
    
    for row in range(rows):
        track_info = {
            "id": row,
            "name": f"Track_{row + 1:02d}",
            "frames": []
        }
        
        for col in range(cols):
            box = (col * frame_w, row * frame_h, (col + 1) * frame_w, (row + 1) * frame_h)
            cell = img.crop(box)
            
            # Check if cell has visible pixels
            alpha = cell.split()[3]
            bbox = alpha.getbbox()
            if not bbox:
                continue
                
            frame_filename = f"track_{row:02d}_frame_{col:02d}.png"
            frame_path = os.path.join(output_dir, frame_filename)
            cell.save(frame_path)
            
            track_info["frames"].append({
                "index": col,
                "file": frame_filename,
                "path": frame_path.replace("\\", "/")
            })
            
            # Extract colors
            raw_colors = cell.getcolors(maxcolors=100000)
            if raw_colors:
                for count, color in raw_colors:
                    if color[3] > 0:
                        palette_set.add(color)
                        
        track_info["frame_count"] = len(track_info["frames"])
        # Only include non-empty rows, or all rows if specified
        if track_info["frame_count"] > 0:
            tracks.append(track_info)
            
    # Sort palette by luminance
    def luminance(c):
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        
    sorted_palette = sorted(list(palette_set), key=luminance)
    hex_palette = [f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}" for c in sorted_palette]
    
    metadata = {
        "source_image": os.path.basename(image_path),
        "source_width": img_w,
        "source_height": img_h,
        "frame_width": frame_w,
        "frame_height": frame_h,
        "cols": cols,
        "rows": rows,
        "tracks": tracks,
        "palette": hex_palette
    }
    
    with open("data/metadata.json", "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)
        
    return metadata

def pack_spritesheet(frames_dir="data/frames", output_path="data/atlas_export.png"):
    """
    Dynamically packs frames according to data/metadata.json.
    """
    if not os.path.exists("data/metadata.json"):
        raise FileNotFoundError("data/metadata.json not found")
        
    with open("data/metadata.json", "r", encoding="utf-8") as f:
        meta = json.load(f)
        
    fw = meta["frame_width"]
    fh = meta["frame_height"]
    cols = meta["cols"]
    rows = meta["rows"]
    
    atlas = Image.new("RGBA", (cols * fw, rows * fh), (0, 0, 0, 0))
    
    for track in meta["tracks"]:
        row = track["id"]
        for frame in track["frames"]:
            col = frame["index"]
            frame_file = os.path.join(frames_dir, frame["file"])
            if os.path.exists(frame_file):
                frame_img = Image.open(frame_file).convert("RGBA")
                atlas.paste(frame_img, (col * fw, row * fh))
                
    atlas.save(output_path)
    return output_path
