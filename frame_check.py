r"""
statusprogram/frame_check.py — ตัวช่วยตรวจคุณภาพภาพกล้อง (เพิ่ม 2 ต.ค. 2569)

status_server.js เปิดไฟล์นี้เองด้วย python ของ Myproject\backend\.venv_cuda (มี OpenCV อยู่แล้ว)
ดึงภาพนิ่งล่าสุดจากส่วนสแกน (/video_feed_frame) ทุก N วินาที แล้วพิมพ์ผลเป็น JSON บรรทัดละครั้ง:
  brightness  ความสว่างเฉลี่ย 0-255   (ต่ำมาก = ภาพมืด/ดำ, สูงมาก = ขาวจ้า)
  contrast    ความต่างของสีในภาพ      (ต่ำมาก = สีเดียวทั้งจอ เช่น เลนส์ถูกบัง)
  sharpness   ความคม (Laplacian)      (ต่ำ = เบลอ / เลนส์สกปรก / โฟกัสหลุด)
  diff        ต่างจากภาพก่อนหน้าแค่ไหน (0 ติดกันหลายรอบ = ภาพค้าง)
อ่านอย่างเดียว ไม่แตะกล้องหรือส่วนสแกน

ใช้: python frame_check.py <url> <วินาทีต่อรอบ> [--once]
"""
import json
import sys
import time
import urllib.request

import cv2
import numpy as np

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/video_feed_frame"
INTERVAL = max(2.0, float(sys.argv[2])) if len(sys.argv) > 2 else 10.0
ONCE = "--once" in sys.argv

prev = None
while True:
    out = {"t": time.time()}
    try:
        with urllib.request.urlopen(URL, timeout=5) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read()
        if "image" not in ctype:
            raise RuntimeError("ยังไม่มีภาพ")
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise RuntimeError("อ่านภาพไม่ได้")
        small = cv2.resize(img, (320, 180), interpolation=cv2.INTER_AREA)
        mid = cv2.resize(img, (640, 360), interpolation=cv2.INTER_AREA)
        out.update(
            ok=True,
            brightness=round(float(small.mean()), 1),
            contrast=round(float(small.std()), 1),
            sharpness=round(float(cv2.Laplacian(mid, cv2.CV_64F).var()), 1),
            diff=None if prev is None else round(float(cv2.absdiff(small, prev).mean()), 3),
        )
        prev = small
    except Exception as e:  # ส่วนสแกนปิด/ไม่มีภาพ → บอกเฉยๆ ไม่ล้ม
        out.update(ok=False, error=f"{type(e).__name__}: {e}"[:120])
        prev = None
    print(json.dumps(out, ensure_ascii=False), flush=True)
    if ONCE:
        break
    time.sleep(INTERVAL)
