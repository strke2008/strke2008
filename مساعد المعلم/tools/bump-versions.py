#!/usr/bin/env python3
"""يحدّث ?v=<بصمة> لكل ملف css/ و js/ في teacher-dashboard/index.html حسب محتواه الحالي.
شغّله بعد تعديل أي ملف تنسيق أو سكربت، حتى يجلب المتصفح النسخة الجديدة."""
import hashlib, os, re
DASH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'teacher-dashboard')
P = os.path.join(DASH, 'index.html')
html = open(P, encoding='utf-8').read()
changed = 0
def repl(m):
    global changed
    rel = m.group(2)
    f = os.path.join(DASH, rel)
    if not os.path.exists(f):
        raise SystemExit(f'ملف مفقود: {rel}')
    v = hashlib.sha1(open(f, encoding='utf-8').read().encode('utf-8')).hexdigest()[:10]
    if v != m.group(3): changed += 1
    return f'{m.group(1)}{rel}?v={v}'
html = re.sub(r'((?:href|src)=")((?:css|js)/[^"?]+)\?v=([0-9a-f]*)', repl, html)
open(P, 'w', encoding='utf-8').write(html)
print(f'حُدّث {changed} رابط' if changed else 'كل الروابط محدّثة')
