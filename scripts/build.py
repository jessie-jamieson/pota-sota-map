#!/usr/bin/env python3
"""Build the single-file POTA + SOTA map from src/.

    python3 scripts/build.py [--src SRC] [--out OUT]

How src/index.html is put together
----------------------------------
`src/index.html` is written so that it works BOTH unbuilt (opened straight from
`src/`, handy while developing) and as the template for the one-file build:

* Two placeholders mark where the bundled assets go. Each sits alone on a line
  inside an otherwise empty tag, and both are ignored by the browser when the
  page is loaded unbuilt (`<!-- ... -->` is a CDO/CDC token pair in CSS and an
  HTML-like line comment in a classic script):

      <style>
      <!-- BUILD:CSS -->
      </style>
      ...
      <script>
      <!-- BUILD:JS -->
      </script>

* Everything between `<!-- DEV-ONLY:BEGIN` and `DEV-ONLY:END -->` is the
  development fallback: a `<link rel=stylesheet href=app.css>` and one
  `<script src=...>` per module. The build deletes those blocks.

The build therefore: reads src/app.css into the CSS placeholder, concatenates
src/*.js in filename order (each preceded by a `/* ==== src/xx-name.js ==== *\\/`
banner) into the JS placeholder, strips the dev-only blocks and writes one
self-contained HTML file. Nothing else is copied; the optional
`data/snapshot.js` is loaded at runtime from next to the output file.
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CSS_PLACEHOLDER = "<!-- BUILD:CSS -->"
JS_PLACEHOLDER = "<!-- BUILD:JS -->"
DEV_BLOCK_RE = re.compile(r"[ \t]*<!--\s*DEV-ONLY:BEGIN.*?DEV-ONLY:END\s*-->[ \t]*\n?", re.S)


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def js_files(src_dir):
    """All src/*.js in filename order (00-util.js first, 90-app.js last)."""
    names = sorted(n for n in os.listdir(src_dir) if n.endswith(".js"))
    return [os.path.join(src_dir, n) for n in names]


def bundle_js(src_dir):
    chunks = []
    for path in js_files(src_dir):
        rel = "src/" + os.path.basename(path)
        body = read(path).rstrip("\n")
        chunks.append("/* ==== %s ==== */\n%s\n" % (rel, body))
    return "\n".join(chunks)


def guard_placeholder(html, placeholder, what):
    if html.count(placeholder) != 1:
        sys.exit(
            "build: expected exactly one %s placeholder for the %s, found %d"
            % (placeholder, what, html.count(placeholder))
        )


def build(src_dir, out_path):
    index = os.path.join(src_dir, "index.html")
    css = os.path.join(src_dir, "app.css")
    for path in (index, css):
        if not os.path.exists(path):
            sys.exit("build: missing %s" % path)

    html = read(index)
    guard_placeholder(html, CSS_PLACEHOLDER, "stylesheet")
    guard_placeholder(html, JS_PLACEHOLDER, "script bundle")

    files = js_files(src_dir)
    if not files:
        sys.exit("build: no .js files in %s" % src_dir)

    # The replacements are done with a lambda so that backslashes or "\\g<0>"-like
    # sequences inside the CSS/JS are never interpreted as regex templates.
    html = html.replace(CSS_PLACEHOLDER, read(css).rstrip("\n"))
    html = html.replace(JS_PLACEHOLDER, bundle_js(src_dir))
    html, n_dev = DEV_BLOCK_RE.subn("", html)

    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    size = os.path.getsize(out_path)
    print("built %s" % os.path.relpath(out_path, ROOT))
    print(
        "  %d JS modules (%s)"
        % (len(files), ", ".join(os.path.basename(f) for f in files))
    )
    print("  %d dev-only block(s) stripped" % n_dev)
    print("  %s bytes (%.1f KB)" % (format(size, ","), size / 1024.0))
    return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Bundle src/ into one self-contained HTML file.")
    ap.add_argument("--src", default=os.path.join(ROOT, "src"), help="source directory (default: src/)")
    ap.add_argument("--out", default=os.path.join(ROOT, "pota-sota-map.html"), help="output HTML file")
    args = ap.parse_args(argv)
    build(args.src, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
