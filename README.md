# Unusual spelling highlighter

Browser demo of a structural unusual-spelling classifier.

Live site: https://junyi-tang.github.io/unusual-spelling-highlighter/

It flags surface forms that look structurally unusual (mixed letters and digits, symbol substitutions, internal punctuation, stretched repeats, spaced letters, mixed scripts, and similar Unicode tricks). Guessed ordinary words are a later reconstruction step, not the detector.

You can also open [index.html](index.html) locally.

Curated v1 benchmark on the page: TP 167, FN 33, FP 0, TN 100. Case-level exact recall 83.5%. Span-level precision 96.0%. The 33 misses are internal spacing splits.
