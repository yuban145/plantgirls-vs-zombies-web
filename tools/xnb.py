"""XNB string/reader helpers.

fmtxt: shared low-level readers for MonoGame/XNA .xnb containers as shipped
with PlantGirlsVsZombies (Lawn engine).  Verified against real files:
  header  : b"XNB", platform byte, version byte (5), flags byte,
            uint32 total file size
  payload : 7-bit reader count, [7-bit strlen + utf8 reader type, int32 version]*
            7-bit shared resource count, then content
  compressed (flag 0x40 on these builds; also accepts 0x80):
            uint32 decompressed size at offset 10, raw LZ4 block stream at 14
Texture content:
  7-bit int (observed 1), int32 surfaceFormat, int32 width, int32 height,
  int32 mipCount, int32 dataSize, then mip bytes (mip0 first).
"""

from __future__ import annotations

import io
import struct
from dataclasses import dataclass, field

XNB_MAGIC = b"XNB"

# XNA/MonoGame SurfaceFormat enum
SF_COLOR = 0
SF_BGR565 = 1
SF_BGRA5551 = 2
SF_BGRA4444 = 3
SF_DXT1 = 4
SF_DXT3 = 5
SF_DXT5 = 6
SF_ALPHA8 = 12

SF_NAMES = {
    SF_COLOR: "color",
    SF_BGR565: "bgr565",
    SF_BGRA5551: "bgra5551",
    SF_BGRA4444: "bgra4444",
    SF_DXT1: "dxt1",
    SF_DXT3: "dxt3",
    SF_DXT5: "dxt5",
    SF_ALPHA8: "alpha8",
}


def read7(data: bytes, pos: int) -> tuple[int, int]:
    """Read a 7-bit encoded unsigned int (LEB128). Returns (value, newpos)."""
    value = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if b < 0x80:
            return value, pos
        shift += 7


def lz4_block_decompress(src: bytes, dst_len: int, max_out: int | None = None) -> bytes:
    """Decode a raw LZ4 block stream (concatenated blocks decoded greedily).

    MonoGame's content compiler writes LZ4 blocks back-to-back with no frame
    header; because every block ends on a literal run, a single greedy pass
    reproduces the stream.  `max_out` allows decoding only a prefix, which is
    used for fast header scanning.
    """
    out = bytearray()
    i = 0
    n = len(src)
    limit = dst_len if max_out is None else min(dst_len, max_out)
    while i < n and len(out) < limit:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            while True:
                b = src[i]
                i += 1
                lit += b
                if b != 255:
                    break
        if lit:
            out += src[i : i + lit]
            i += lit
        if i >= n or len(out) >= limit:
            break
        off = src[i] | (src[i + 1] << 8)
        i += 2
        ml = token & 0x0F
        if ml == 15:
            while True:
                b = src[i]
                i += 1
                ml += b
                if b != 255:
                    break
        ml += 4
        start = len(out) - off
        if start < 0:
            raise ValueError(f"invalid LZ4 match offset {off} at output {len(out)}")
        # byte-wise: overlapping copies are legal in LZ4
        for k in range(ml):
            out.append(out[start + k])
    return bytes(out[:limit])


@dataclass
class XnbFile:
    path: str
    flags: int
    readers: list[tuple[str, int]]
    shared_count: int
    content: bytes
    total_size: int
    platform: int = 109
    version: int = 5
    extra: dict = field(default_factory=dict)

    @property
    def compressed(self) -> bool:
        return bool(self.flags & (0x40 | 0x80))


def read_xnb(path: str, max_content: int | None = None) -> XnbFile:
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:3] != XNB_MAGIC:
        raise ValueError(f"{path}: not an XNB file")
    platform = raw[3]
    version = raw[4]
    flags = raw[5]
    size = struct.unpack_from("<I", raw, 6)[0]
    if flags & (0x40 | 0x80):
        dst_len = struct.unpack_from("<I", raw, 10)[0]
        content = lz4_block_decompress(raw[14:], dst_len, max_content)
        compressed = True
    else:
        content = raw[10:] if max_content is None else raw[10 : 10 + max_content]
        compressed = False
    pos = 0
    reader_count, pos = read7(content, pos)
    readers: list[tuple[str, int]] = []
    for _ in range(reader_count):
        ln, pos = read7(content, pos)
        rtype = content[pos : pos + ln].decode("utf-8", "replace")
        pos += ln
        rver = struct.unpack_from("<i", content, pos)[0]
        pos += 4
        readers.append((rtype, rver))
    shared_count, pos = read7(content, pos)
    return XnbFile(
        path=path,
        flags=flags,
        readers=readers,
        shared_count=shared_count,
        content=content[pos:],
        total_size=size,
        platform=platform,
        version=version,
        extra={"compressed": compressed, "content_offset": pos},
    )


def _dds_for_dxt(data: bytes, width: int, height: int, fourcc: bytes) -> bytes:
    """Wrap raw BC1/2/3 data in a DDS container so Pillow can decode it."""
    block_bytes = 8 if fourcc == b"DXT1" else 16
    linear_size = max(1, (width + 3) // 4) * max(1, (height + 3) // 4) * block_bytes
    flags = 0x00081007  # CAPS | HEIGHT | WIDTH | PIXELFORMAT | LINEARSIZE
    header = struct.pack("<I", 124)
    header += struct.pack("<I", flags)
    header += struct.pack("<I", height)
    header += struct.pack("<I", width)
    header += struct.pack("<I", linear_size)
    header += struct.pack("<I", 0)  # depth
    header += struct.pack("<I", 1)  # mip count
    header += b"\x00" * 44  # reserved1[11]
    header += struct.pack("<I", 32)  # pixelformat size
    header += struct.pack("<I", 0x4)  # DDPF_FOURCC
    header += fourcc
    header += struct.pack("<I", 0)  # bit count
    header += b"\x00" * 16  # masks
    header += struct.pack("<I", 0x1000)  # caps: texture
    header += b"\x00" * 16  # caps2..4, reserved2
    assert len(header) == 124, len(header)
    return b"DDS " + header + data


def decode_texture(xnb: XnbFile):
    """Decode the XNB's Texture2D payload into a Pillow RGBA image.

    Returns (image, meta) where meta has format/width/height/mipCount.
    """
    from PIL import Image  # imported lazily so header-only scans stay cheap

    pos = 0
    # observed leading 7-bit int; MonoGame writes 1 here for plain 2D textures
    leading, pos = read7(xnb.content, pos)
    fmt, w, h, mips, data_size = struct.unpack_from("<iiiii", xnb.content, pos)
    pos += 20
    data = xnb.content[pos : pos + data_size]
    if len(data) != data_size:
        raise ValueError(f"{xnb.path}: truncated texture data ({len(data)}/{data_size})")
    meta = {
        "surfaceFormat": fmt,
        "surfaceName": SF_NAMES.get(fmt, f"unknown{fmt}"),
        "width": w,
        "height": h,
        "mipCount": mips,
        "dataSize": data_size,
        "leading": leading,
    }
    if fmt == SF_COLOR:
        # SurfaceFormat.Color stores R,G,B,A bytes (not Windows bitmap BGRA).
        img = Image.frombytes("RGBA", (w, h), data, "raw", "RGBA", 0, 1)
        return img, meta
    if fmt in (SF_DXT1, SF_DXT3, SF_DXT5):
        fourcc = {SF_DXT1: b"DXT1", SF_DXT3: b"DXT3", SF_DXT5: b"DXT5"}[fmt]
        dds = _dds_for_dxt(data, w, h, fourcc)
        img = Image.open(io.BytesIO(dds)).convert("RGBA")
        return img, meta
    if fmt == SF_BGRA4444:
        # 2 bytes per pixel: 4 bits per channel; used by some legacy UI art
        out = Image.new("RGBA", (w, h))
        px = out.load()
        for y in range(h):
            row = y * w * 2
            for x in range(w):
                v = data[row + x * 2] | (data[row + x * 2 + 1] << 8)
                a = ((v >> 12) & 0xF) * 17
                r = ((v >> 8) & 0xF) * 17
                g = ((v >> 4) & 0xF) * 17
                b = (v & 0xF) * 17
                px[x, y] = (r, g, b, a)
        return out, meta
    if fmt == SF_ALPHA8:
        return Image.frombytes("L", (w, h), data).convert("RGBA"), meta
    raise ValueError(f"{xnb.path}: unsupported surface format {fmt}")


def load_texture(path: str):
    return decode_texture(read_xnb(path))
