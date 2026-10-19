"""
Pixel Art Draft Generator.
Generates initial character base drafts and variations for any canvas size.
"""
import os
import json
from PIL import Image, ImageDraw

def create_base_mannequin(width=24, height=32, skin_tone="#f2d3a2", outline="#202124", cloth_color="#2b7a78", hair_color="#a8b2b7"):
    """
    Creates a clean base humanoid draft template for the given width and height.
    Scales proportions dynamically according to canvas size.
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    def hex_to_rgba(h):
        h = h.lstrip("#")
        return tuple(int(h[i:i+2], 16) for i in (0, 2, 4)) + (255,)
        
    c_skin = hex_to_rgba(skin_tone)
    c_out = hex_to_rgba(outline)
    c_cloth = hex_to_rgba(cloth_color)
    c_hair = hex_to_rgba(hair_color)
    c_shadow = (max(0, c_cloth[0] - 40), max(0, c_cloth[1] - 40), max(0, c_cloth[2] - 40), 255)
    c_skin_shadow = (max(0, c_skin[0] - 30), max(0, c_skin[1] - 30), max(0, c_skin[2] - 30), 255)
    
    # Head & Hair proportions
    head_y_start = int(height * 0.05)
    head_h = int(height * 0.35)
    head_w = int(width * 0.5)
    cx = width // 2
    
    head_box = [cx - head_w // 2, head_y_start, cx + head_w // 2, head_y_start + head_h]
    
    # Hair base
    draw.rectangle([head_box[0] - 1, head_box[1], head_box[2] + 1, head_box[3] - 2], fill=c_hair)
    # Face skin
    draw.rectangle([head_box[0] + 1, head_box[1] + 3, head_box[2] - 1, head_box[3] - 1], fill=c_skin)
    # Eye
    eye_x = cx + head_w // 4
    eye_y = head_y_start + int(head_h * 0.55)
    draw.point((eye_x, eye_y), fill=c_out)
    
    # Torso
    torso_y_start = head_box[3]
    torso_h = int(height * 0.28)
    torso_w = int(width * 0.4)
    torso_box = [cx - torso_w // 2, torso_y_start, cx + torso_w // 2, torso_y_start + torso_h]
    draw.rectangle(torso_box, fill=c_cloth)
    
    # Arms
    arm_w = max(2, int(width * 0.12))
    # Front arm
    draw.rectangle([torso_box[2], torso_y_start + 1, torso_box[2] + arm_w, torso_y_start + torso_h - 1], fill=c_cloth)
    draw.point((torso_box[2], torso_y_start + torso_h), fill=c_skin)
    # Back arm (shadowed)
    draw.rectangle([torso_box[0] - arm_w, torso_y_start + 1, torso_box[0], torso_y_start + torso_h - 1], fill=c_shadow)
    
    # Legs & Shoes
    leg_y_start = torso_box[3]
    leg_h = height - leg_y_start
    leg_w = max(2, int(width * 0.16))
    
    # Back leg
    draw.rectangle([cx - leg_w - 1, leg_y_start, cx - 1, height - 3], fill=c_shadow)
    draw.rectangle([cx - leg_w - 2, height - 3, cx, height - 1], fill=c_out) # Shoe
    
    # Front leg
    draw.rectangle([cx, leg_y_start, cx + leg_w, height - 3], fill=c_cloth)
    draw.rectangle([cx - 1, height - 3, cx + leg_w + 1, height - 1], fill=c_out) # Shoe
    
    return img

def generate_draft_preset(style_name, width=24, height=32, output_dir="data/drafts"):
    os.makedirs(output_dir, exist_ok=True)
    presets = {
        "silver_scout": {"skin": "#f5d0b0", "out": "#1a1c23", "cloth": "#177e89", "hair": "#b0b8bf"},
        "red_warrior": {"skin": "#f0c294", "out": "#1e1414", "cloth": "#b33939", "hair": "#4b3832"},
        "dark_mage": {"skin": "#e6be8a", "out": "#120e1f", "cloth": "#3c2e59", "hair": "#e5d4ed"},
        "forest_ranger": {"skin": "#fad390", "out": "#1c2826", "cloth": "#218c74", "hair": "#784212"},
        "cyber_ninja": {"skin": "#d8b28a", "out": "#0d131a", "cloth": "#2c3e50", "hair": "#00d2d3"}
    }
    
    preset = presets.get(style_name, presets["silver_scout"])
    img = create_base_mannequin(
        width=width,
        height=height,
        skin_tone=preset["skin"],
        outline=preset["out"],
        cloth_color=preset["cloth"],
        hair_color=preset["hair"]
    )
    
    file_path = os.path.join(output_dir, f"draft_{style_name}_{width}x{height}.png")
    img.save(file_path)
    return file_path
