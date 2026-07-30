#!/usr/bin/env python3
"""Генерирует иконки приложения без внешних библиотек (чистый zlib + struct).

Рисунок: тёмный фон и две наложенные «карточки» — намёк на колоду.
Запуск: python3 tools/make-icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'app', 'icons')

BG = (18, 19, 26)
CARD_BACK = (108, 140, 255)
CARD_FRONT = (236, 238, 244)
INK = (26, 28, 38)


def blend(dst, src, a):
    return tuple(int(dst[i] * (1 - a) + src[i] * a) for i in range(3))


def rounded_rect(px, size, x0, y0, x1, y1, r, color, alpha=1.0):
    """Мягкие края: считаем покрытие пикселя по расстоянию до скруглённого угла."""
    for y in range(max(0, int(y0) - 1), min(size, int(y1) + 2)):
        for x in range(max(0, int(x0) - 1), min(size, int(x1) + 2)):
            cx = min(max(x + 0.5, x0 + r), x1 - r)
            cy = min(max(y + 0.5, y0 + r), y1 - r)
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            d = (dx * dx + dy * dy) ** 0.5
            cov = max(0.0, min(1.0, r + 0.5 - d)) if (dx or dy) else 1.0
            if x + 0.5 < x0 or x + 0.5 > x1 or y + 0.5 < y0 or y + 0.5 > y1:
                cov = 0.0
            if cov <= 0:
                continue
            px[y][x] = blend(px[y][x], color, cov * alpha)


def write_png(path, px, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            raw += bytes(px[y][x])
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def draw(size, maskable=False):
    px = [[BG for _ in range(size)] for _ in range(size)]
    u = size / 100.0
    if maskable:
        # у maskable-иконки система обрезает края, поэтому рисуем компактнее
        rounded_rect(px, size, 0, 0, size, size, 0, BG)
        pad, scale = 26 * u, 0.72
    else:
        rounded_rect(px, size, 0, 0, size, size, 22 * u, BG)
        pad, scale = 16 * u, 1.0

    w = (100 * u - 2 * pad) * scale
    left = (size - w) / 2

    # задняя карточка — сдвинута и подкрашена
    rounded_rect(px, size, left + w * 0.14, pad + w * 0.02, left + w * 1.02, pad + w * 0.76, 7 * u, CARD_BACK, 0.95)
    # передняя карточка
    rounded_rect(px, size, left - w * 0.02, pad + w * 0.20, left + w * 0.86, pad + w * 0.98, 7 * u, CARD_FRONT)

    # три «строки текста» на передней карточке
    y = pad + w * 0.40
    for i, frac in enumerate((0.52, 0.40, 0.28)):
        rounded_rect(px, size, left + w * 0.08, y, left + w * (0.08 + frac), y + 4.5 * u, 2.2 * u, INK, 0.85)
        y += 12 * u
    return px


def main():
    os.makedirs(OUT, exist_ok=True)
    for size, name, mask in ((192, 'icon-192.png', False), (512, 'icon-512.png', False), (512, 'icon-512-maskable.png', True)):
        write_png(os.path.join(OUT, name), draw(size, mask), size)
        print('ok', name, size)


if __name__ == '__main__':
    main()
