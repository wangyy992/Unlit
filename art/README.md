# 美术资源

## 目录约定

- `source/`：高分辨率美工源图和概念稿，不由游戏直接加载。
- `*.png` / `*.jpg`：游戏运行时使用的裁切、透明化和优化后资源。
- `tools/extract-sprites.ps1`：从源图重新导出幽灵、压力板和机关门。

这样可以避免把带棋盘格的 JPG 源图直接缩到几十像素后显示，保留高分辨率母版，也让运行时素材保持透明、轻量和名称明确。

## 对照表

| 游戏资源 | 源文件 | 用途 |
|---|---|---|
| `ghost-lumen.png` | `source/ghost-lumen-sheet-source.jpg` | 光灵 |
| `ghost-umbra.png` | `source/ghost-umbra-sheet-source.jpg` | 影灵 |
| `pressure-plate.png` | `source/mechanisms-concept.png` | 压力板 / 常压板 |
| `gate-block.png` | `source/mechanisms-concept.png` | 阻挡门 |
| `door-lumen.png` | `source/door-lumen-source.jpg` | 光灵终点门 |
| `door-umbra.png` | `source/door-umbra-gothic-source.jpg` | 影灵终点门 |
| `wall.jpg` | `source/wall-panels-source.jpg` | 墙体平铺纹理 |
| `bg.jpg` | `source/dungeon-background-source.jpg` | 关卡背景 |

## 重新导出

在仓库根目录运行：

```powershell
.\tools\extract-sprites.ps1
```

导出图保留较高分辨率，由 Canvas 在最终物理像素尺寸上一次性采样。不要提前把源图缩成 32px，也不要把伪透明棋盘格 JPG 直接交给引擎。
