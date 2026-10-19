"""
Localized Pixel Patching & Vision Inspection Engine.
Provides sub-pixel cropping, grid overlays for AI vision, and surgical pixel replacements.
Supports patching both individual frames and directly modifying the source atlas.
"""
import os
import json
from PIL import Image, ImageDraw

def create_inspection_views(frame_path, bbox, scale=16, output_prefix="data/inspect"):
    """
    Creates high-res nearest-neighbor views for AI/user inspection:
    1. Full frame (scaled 16x) with a highlight box over the target region.
    2. Zoomed micro-crop of the target region with pixel grid lines and coordinate labels.
    """
    os.makedirs(os.path.dirname(output_prefix), exist_ok=True)
    if not os.path.exists(frame_path):
        raise FileNotFoundError(f"Frame path not found: {frame_path}")
        
    img = Image.open(frame_path).convert("RGBA")
    w, h = img.size
    x1, y1, x2, y2 = bbox
    
    # Clamp bbox
    x1 = max(0, min(x1, w - 1))
    y1 = max(0, min(y1, h - 1))
    x2 = max(x1 + 1, min(x2, w))
    y2 = max(y1 + 1, min(y2, h))
    
    # 1. Full context view (scaled up)
    full_scaled = img.resize((w * scale, h * scale), Image.NEAREST)
    draw_full = ImageDraw.Draw(full_scaled)
    # Bright red/magenta outline for visibility in light mode
    draw_full.rectangle(
        [x1 * scale, y1 * scale, x2 * scale - 1, y2 * scale - 1],
        outline=(230, 20, 60, 255),
        width=2
    )
    full_path = f"{output_prefix}_context.png"
    full_scaled.save(full_path)
    
    # 2. Zoomed crop view
    crop_w = x2 - x1
    crop_h = y2 - y1
    cropped = img.crop((x1, y1, x2, y2))
    
    # Scale crop generously (32px per pixel cell)
    crop_cell_size = 32
    crop_scaled = cropped.resize((crop_w * crop_cell_size, crop_h * crop_cell_size), Image.NEAREST)
    draw_crop = ImageDraw.Draw(crop_scaled)
    
    # Draw grid
    for gx in range(crop_w + 1):
        draw_crop.line([(gx * crop_cell_size, 0), (gx * crop_cell_size, crop_h * crop_cell_size)], fill=(100, 100, 100, 160), width=1)
    for gy in range(crop_h + 1):
        draw_crop.line([(0, gy * crop_cell_size), (crop_w * crop_cell_size, gy * crop_cell_size)], fill=(100, 100, 100, 160), width=1)
        
    crop_path = f"{output_prefix}_micro.png"
    crop_scaled.save(crop_path)
    
    return {
        "context_image": full_path.replace("\\", "/"),
        "micro_image": crop_path.replace("\\", "/"),
        "bbox": [x1, y1, x2, y2],
        "crop_size": [crop_w, crop_h]
    }

def apply_pixel_matrix_to_atlas(atlas_path, frame_w, frame_h, row, col, bbox, pixel_matrix):
    """
    Directly patches the source atlas PNG at the calculated absolute coordinate offset!
    """
    img = Image.open(atlas_path).convert("RGBA")
    base_x = col * frame_w + bbox[0]
    base_y = row * frame_h + bbox[1]
    
    for r_idx, row_data in enumerate(pixel_matrix):
        py = base_y + r_idx
        if py >= img.height:
            break
        for c_idx, color_val in enumerate(row_data):
            px = base_x + c_idx
            if px >= img.width:
                break
            if color_val is None:
                continue
            c = parse_color(color_val)
            if c is not None:
                img.putpixel((px, py), c)
                
    img.save(atlas_path)
    return atlas_path

def parse_color(color_val):
    if isinstance(color_val, str):
        color_val = color_val.strip()
        if color_val == "" or color_val.lower() in ("none", "transparent"):
            return (0, 0, 0, 0)
        elif color_val.startswith("#"):
            hex_str = color_val.lstrip("#")
            if len(hex_str) == 6:
                return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4)) + (255,)
            elif len(hex_str) == 8:
                return tuple(int(hex_str[i:i+2], 16) for i in (0, 2, 4, 6))
    elif isinstance(color_val, (list, tuple)):
        if len(color_val) == 3:
            return tuple(color_val) + (255,)
        elif len(color_val) == 4:
            return tuple(color_val)
    return None
