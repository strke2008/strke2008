#!/usr/bin/env python3
"""تقسيم teacher-dashboard/index.html إلى ملفات CSS و JS منفصلة دون تغيير أي سلوك.

القواعد التي تضمن التطابق:
- كل <style> يُستبدل بـ <link rel="stylesheet"> في نفس مكانه تمامًا، فترتيب
  التنسيقات (cascade) لا يتغير. الكتل المتتالية بلا فاصل تُدمج في ملف واحد لأن
  دمجها لا يغيّر الترتيب. الكتلة ذات المعرّف المستخدم في الكود تبقى ملفًا مستقلًا
  بنفس المعرّف (الكود يعطّلها مؤقتًا أثناء طباعة الاختبار).
- كل <script> يصبح ملفًا مستقلًا (لا دمج): كل سكربت كلاسيكي وحدة مستقلة؛ خطأ في
  أحدها لا يوقف غيره، و'use strict' لا يتسرب لسكربت آخر.
- <style>/<script> داخل نصوص JavaScript (مثل شعار الوزارة SVG) لا تُلمس: الماسح
  يتخطى محتوى كل سكربت كنص خام حتى </script>.
- كل رابط يحمل ?v=<بصمة المحتوى> فلا يبقى المتصفح على نسخة قديمة بعد التحديث.

الاستخدام:  python3 tools/split-dashboard.py           (يكتب الملفات ويستبدل index.html)
            python3 tools/split-dashboard.py --check   (يتحقق فقط، لا يكتب)
"""
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DASH = os.path.join(HERE, '..', 'teacher-dashboard')
SRC = os.path.join(DASH, 'index.html')
KEEP_SEPARATE_STYLE_IDS = {'comprehensive-print-identical-all-devices'}

OPEN_RE = re.compile(r'<(script|style)\b([^>]*)>', re.I)


def scan(html):
    """يعيد قائمة أجزاء: ('html', نص) أو (tag, attrs, body) بالترتيب."""
    parts, i = [], 0
    while True:
        m = OPEN_RE.search(html, i)
        # تخطّ التعليقات <!-- --> في المستوى الأعلى
        c = html.find('<!--', i)
        if c != -1 and (m is None or c < m.start()):
            e = html.find('-->', c)
            e = len(html) if e == -1 else e + 3
            parts.append(('html', html[i:e]))
            i = e
            continue
        if m is None:
            parts.append(('html', html[i:]))
            return parts
        tag, attrs = m.group(1).lower(), m.group(2)
        close = re.compile(r'</%s\s*>' % tag, re.I).search(html, m.end())
        if close is None:
            raise SystemExit(f'<{tag}> بلا إغلاق عند الحرف {m.start()}')
        parts.append(('html', html[i:m.start()]))
        parts.append((tag, attrs, html[m.end():close.start()]))
        i = close.end()


def slug(s):
    s = re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')
    return s[:48] or 'block'


def ver(text):
    return hashlib.sha1(text.encode('utf-8')).hexdigest()[:10]


def attr(attrs, name):
    m = re.search(r'\b%s\s*=\s*"([^"]*)"' % name, attrs)
    return m.group(1) if m else None


def build(html):
    parts = scan(html)
    files, out = {}, []
    n = {'css': 0, 'js': 0}
    pending = []  # كتل style متتالية تنتظر الدمج

    def flush_styles():
        if not pending:
            return
        n['css'] += 1
        first_id = attr(pending[0][0], 'id')
        name = f"{n['css']:02d}-{slug(first_id or 'styles')}.css"
        body = '\n'.join(f'/* ── {attr(a, "id") or "style"} ── */\n{b.strip()}\n' for a, b in pending)
        files['css/' + name] = body
        id_attr = f' id="{first_id}"' if len(pending) == 1 and first_id in KEEP_SEPARATE_STYLE_IDS else ''
        out.append(f'<link rel="stylesheet" href="css/{name}?v={ver(body)}"{id_attr}>')
        pending.clear()

    for p in parts:
        if p[0] == 'html':
            if p[1].strip():          # فاصل حقيقي: لا ندمج عبره
                flush_styles()
                out.append(p[1])
            else:
                if not pending:
                    out.append(p[1])
            continue
        tag, attrs, body = p
        if tag == 'style':
            sid = attr(attrs, 'id')
            if re.search(r'\bmedia\s*=', attrs) or re.search(r'\btype\s*=\s*"(?!text/css)', attrs):
                flush_styles(); out.append(f'<style{attrs}>{body}</style>'); continue
            if sid in KEEP_SEPARATE_STYLE_IDS:
                flush_styles(); pending.append((attrs, body)); flush_styles(); continue
            pending.append((attrs, body))
            continue
        # script
        flush_styles()
        if attr(attrs, 'src') is not None or re.search(r'\btype\s*=\s*"(?!text/javascript)', attrs) or not body.strip():
            out.append(f'<script{attrs}>{body}</script>')
            continue
        n['js'] += 1
        sid = attr(attrs, 'id')
        name = f"{n['js']:02d}-{slug(sid or 'app')}.js"
        files['js/' + name] = body.strip('\n') + '\n'
        rest = re.sub(r'\s*\bid\s*=\s*"[^"]*"', '', attrs).strip()
        id_attr = f' id="{sid}"' if sid else ''
        out.append(f'<script src="js/{name}?v={ver(files["js/" + name])}"{id_attr}{(" " + rest) if rest else ""}></script>')
    flush_styles()
    return ''.join(out), files


def main():
    html = open(SRC, encoding='utf-8').read()
    if 'href="css/' in html and '<style' not in html.split('</head>')[0]:
        raise SystemExit('يبدو أن الملف مقسّم مسبقًا.')
    new_html, files = build(html)
    total = sum(len(v.encode()) for v in files.values())
    print(f'css: {sum(1 for k in files if k.startswith("css/"))} ملف · js: {sum(1 for k in files if k.startswith("js/"))} ملف · '
          f'{total // 1024} KB خارج index.html · index.html: {len(new_html.encode()) // 1024} KB')
    if '--check' in sys.argv:
        return
    for rel, body in files.items():
        path = os.path.join(DASH, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(body)
    with open(SRC, 'w', encoding='utf-8') as f:
        f.write(new_html)


if __name__ == '__main__':
    main()
