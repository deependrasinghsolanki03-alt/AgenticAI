import os
import sys
import glob
import time

# Add NVIDIA CUDA DLL paths so onnxruntime can find cuBLAS, cuDNN, etc.
_site_packages = os.path.join(os.path.dirname(os.path.dirname(os.__file__)), 'Lib', 'site-packages', 'nvidia')
if os.path.isdir(_site_packages):
    for _pkg in os.listdir(_site_packages):
        _bin = os.path.join(_site_packages, _pkg, 'bin')
        if os.path.isdir(_bin):
            if _bin not in os.environ.get('PATH', ''):
                os.environ['PATH'] = _bin + os.pathsep + os.environ.get('PATH', '')
            if hasattr(os, 'add_dll_directory'):
                os.add_dll_directory(_bin)

import imageio
from rembg import remove, new_session

# Try to create session with CUDA first, fall back to CPU
try:
    import onnxruntime as ort
    available = ort.get_available_providers()
    if 'CUDAExecutionProvider' in available:
        # Test if CUDA actually works
        session = new_session("u2net", providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        provider_name = "CUDA (GPU)"
    else:
        session = new_session("u2net", providers=['CPUExecutionProvider'])
        provider_name = "CPU"
except Exception:
    session = new_session("u2net", providers=['CPUExecutionProvider'])
    provider_name = "CPU"

video_folder = "png"
videos = glob.glob(f"{video_folder}/*.mp4")

if not videos:
    print("Error: 'png' folder mein koi .mp4 video nahi mili. Kripya check karein.")
    exit()

print(f"Total {len(videos)} videos found. Using {provider_name} for background removal...")

for vid_path in videos:
    filename = os.path.basename(vid_path)
    out_path = f"{video_folder}/transparent_{filename.replace('.mp4', '.webm')}"
    
    print(f"\nProcessing: {filename} -> {out_path}")
    
    reader = imageio.get_reader(vid_path)
    meta = reader.get_meta_data()
    fps = meta.get('fps', 30)
    
    # WebM format with VP9 codec supports RGBA (transparency)
    writer = imageio.get_writer(
        out_path, 
        fps=fps, 
        format='webm', 
        codec='vp9', 
        pixelformat='rgba'
    )
    
    # Count total frames for progress
    try:
        n_frames = reader.count_frames()
    except Exception:
        n_frames = None
    
    # Process frame by frame
    vid_start = time.time()
    try:
        for i, frame in enumerate(reader):
            frame_start = time.time()
            
            # rembg removes the background using U-Net model, reusing session
            bg_removed_frame = remove(frame, session=session)
            writer.append_data(bg_removed_frame)
            
            elapsed = time.time() - frame_start
            if n_frames:
                print(f"  Frame {i+1}/{n_frames} ({elapsed:.1f}s/frame)", end='\r')
            elif i % 10 == 0:
                print(f"  -> Processing frame {i}... ({elapsed:.1f}s/frame)")
    except Exception as e:
        print(f"\nError processing {filename}: {e}")
        
    writer.close()
    reader.close()
    vid_elapsed = time.time() - vid_start
    print(f"\n[OK] Saved: {out_path} ({vid_elapsed:.1f}s total)")

print("\n[DONE] Saare videos process ho gaye! Ab aap in transparent .webm files ko use kar sakte hain.")
